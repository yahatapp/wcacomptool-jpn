import { CpModel, CpSolver, setCloudNoticeEnabled, sum, terminateLoadedRuntimeThreads } from 'or-tools-wasm/cp-sat'
import type { BoolVar, LinearExprLike } from 'or-tools-wasm/cp-sat'
import { roleLabels } from './roles.ts'
import type { Assignment, Competitor, Role, SolveRequest, SolveResponse } from './assignments.ts'
import { compareText, key, validateSolveRequest } from './competition.ts'
import { exportCsv } from './result-csv.ts'

type StaffRole = Exclude<Role, 'COMPETITOR'>
const staffRoles: StaffRole[] = ['SCRAMBLER', 'JUDGE', 'RUNNER']
type Groups = Map<string, number>

export function assignGroups(request: SolveRequest): Groups {
  const groups: Groups = new Map()
  for (const event of request.events) {
    // Stable sorting preserves CSV order for equal or absent averages.
    const participants = request.competitors.filter((person) => Object.hasOwn(person.events, event.event_id))
      .sort((a, b) => (a.events[event.event_id].average_time ?? Infinity) - (b.events[event.event_id].average_time ?? Infinity))
    const size = Math.floor(participants.length / event.num_groups), remainder = participants.length % event.num_groups
    let offset = 0
    for (let group = 0; group < event.num_groups; group++) {
      const count = size + Number(group < remainder)
      for (const person of participants.slice(offset, offset + count)) groups.set(key(person.competitor_id, event.event_id), group)
      offset += count
    }
  }
  return groups
}

function canStaff(person: Competitor, eventId: string, group: number, groups: Groups): boolean {
  const own = groups.get(key(person.competitor_id, eventId))
  return own === undefined || (group !== own && group !== own - 1)
}

function eligible(person: Competitor, eventId: string, role: StaffRole, ageLimit: number): boolean {
  if (person.is_staff) return false
  if (role === 'SCRAMBLER') return Object.hasOwn(person.events, eventId) && !person.is_scrambler_exempt
  if (role === 'JUDGE') return person.age > ageLimit && !person.is_newcomer && !person.is_judge_exempt
  return true
}

function staffingRequirements(request: SolveRequest, groups: Groups) {
  return request.events.flatMap((event) => Array.from({ length: event.num_groups }, (_, group) => ({
    event, group,
    counts: {
      SCRAMBLER: event.num_scramblers_per_group,
      JUDGE: request.competitors.filter((person) => groups.get(key(person.competitor_id, event.event_id)) === group).length,
      RUNNER: event.use_runners ? event.num_runners_per_group : 0,
    },
  })))
}

function increment(counts: Map<string, number>, id: string) { counts.set(id, (counts.get(id) ?? 0) + 1) }

// Check the final plan independently of the CP-SAT variables before producing a CSV.
export function validateAssignments(request: SolveRequest, assignments: Assignment[]): string[] {
  const errors: string[] = [], groups = assignGroups(request)
  const people = new Map(request.competitors.map((person) => [person.competitor_id, person]))
  const events = new Map(request.events.map((event) => [event.event_id, event]))
  const occupied = new Map<string, number>(), competing = new Map<string, number>(), staff = new Map<string, number>()
  for (const item of assignments) {
    const person = people.get(item.competitor_id), event = events.get(item.event_id)
    if (!person || !event || !Number.isInteger(item.group) || item.group < 1 || item.group > event.num_groups || !Object.hasOwn(roleLabels, item.role)) {
      errors.push('不明な参加者・競技・グループ・役割の割り当てがあります。'); continue
    }
    increment(occupied, key(item.competitor_id, item.event_id, item.group))
    if (item.role === 'COMPETITOR') {
      increment(competing, key(item.competitor_id, item.event_id))
      if (groups.get(key(item.competitor_id, item.event_id)) !== item.group - 1) errors.push(`${person.name}: 競技グループが入力から決まるグループと一致していません。`)
    } else {
      increment(staff, key(item.event_id, item.group - 1, item.role))
      if (!eligible(person, item.event_id, item.role, request.options.judge_exempt_age)) errors.push(`${person.name}: ${roleLabels[item.role]}の資格制約に違反しています。`)
      if (!canStaff(person, item.event_id, item.group - 1, groups)) errors.push(`${person.name}: 自分の競技グループまたは直前グループに役割があります。`)
    }
  }
  if (competing.size !== groups.size || [...groups.keys()].some((id) => competing.get(id) !== 1)) errors.push('全員の参加競技に対する競技グループが1つずつ必要です。')
  if ([...occupied.values()].some((count) => count > 1)) errors.push('同一グループで複数の役割を兼任しています。')
  for (const { event, group, counts } of staffingRequirements(request, groups)) {
    for (const role of staffRoles) {
      if ((staff.get(key(event.event_id, group, role)) ?? 0) !== counts[role]) errors.push(`${event.event_id} G${group + 1}: ${roleLabels[role]}の必要人数を満たしていません。`)
    }
  }
  return errors
}

export async function solve(request: SolveRequest, workerCount = 1): Promise<SolveResponse> {
  validateSolveRequest(request)
  setCloudNoticeEnabled(false)
  const started = performance.now(), groups = assignGroups(request)
  const result: SolveResponse = { status: 'UNKNOWN', solve_time_seconds: 0, objective_value: null,
    assignments: [], diagnostics: [], warnings: [], validation_errors: [], csv_content: '' }
  const finish = () => { result.solve_time_seconds = (performance.now() - started) / 1000; return result }
  type Candidate = { eventId: string; group: number; role: StaffRole; needed: number; people: Competitor[] }
  const candidates: Candidate[] = []
  for (const event of request.events) {
    const missing = request.competitors.filter((person) => Object.hasOwn(person.events, event.event_id) && person.events[event.event_id].average_time === null).length
    if (missing) result.warnings.push(`${event.event_name}: ${missing}人の平均記録が未入力です（未入力者は順位の末尾）。`)
  }
  for (const { event, group, counts } of staffingRequirements(request, groups)) {
    if (counts.JUDGE > request.num_stations) result.warnings.push(`${event.event_name} G${group + 1}: 競技者が競技卓数を超えています。待機席が必要です。`)
    const uniqueCandidates = new Set<string>()
    for (const role of staffRoles) {
      const needed = counts[role]
      const people = needed ? request.competitors.filter((person) => canStaff(person, event.event_id, group, groups)
        && eligible(person, event.event_id, role, request.options.judge_exempt_age)) : []
      candidates.push({ eventId: event.event_id, group, role, needed, people })
      for (const person of people) uniqueCandidates.add(person.competitor_id)
      if (people.length < needed) result.diagnostics.push(`${event.event_name} G${group + 1}: ${roleLabels[role]}は${needed}人必要ですが、条件を満たす候補者は${people.length}人です。`)
    }
    const total = Object.values(counts).reduce((a, b) => a + b, 0)
    if (uniqueCandidates.size < total) result.diagnostics.push(`${event.event_name} G${group + 1}: 兼任不可のためスタッフは合計${total}人必要ですが、候補者は${uniqueCandidates.size}人です。`)
  }
  if (result.diagnostics.length) { result.status = 'INFEASIBLE'; return finish() }

  const model = new CpModel(), byPerson = new Map<string, BoolVar[]>(), bySlot = new Map<string, BoolVar[]>()
  const variables: { person: Competitor; eventId: string; group: number; role: StaffRole; variable: BoolVar }[] = []
  const push = (map: Map<string, BoolVar[]>, id: string, variable: BoolVar) => {
    const list = map.get(id) ?? []; list.push(variable); map.set(id, list)
  }
  for (const { eventId, group, role, needed, people } of candidates) {
    const roleVariables: BoolVar[] = []
    for (const person of people) {
      const variable = model.newBoolVar(`role_${variables.length}`)
      variables.push({ person, eventId, group, role, variable })
      push(byPerson, person.competitor_id, variable)
      push(bySlot, key(person.competitor_id, eventId, group), variable)
      roleVariables.push(variable)
    }
    model.addLinearConstraint(sum(roleVariables), needed, needed)
  }
  for (const roleVariables of bySlot.values()) model.addLinearConstraint(sum(roleVariables), 0, 1)
  const objective: LinearExprLike[] = []
  for (const event of request.events) {
    const times = request.competitors.flatMap((person) => {
      const average = person.events[event.event_id]?.average_time
      return average == null ? [] : [average]
    })
    if (!times.length) continue
    const maxTime = Math.max(...times)
    for (const { person, eventId, role, variable } of variables) {
      if (eventId !== event.event_id || role !== 'SCRAMBLER') continue
      const average = person.events[eventId].average_time
      const score = average === null ? 0 : Math.min(1_000_000, Math.trunc(maxTime / average * 1000))
      objective.push(variable.times(score * request.options.scrambler_speed_weight))
    }
  }
  const maxRoles = request.events.reduce((count, event) => count + event.num_groups, 0)
  const totals = request.competitors.map((person, index) => {
    const total = model.newIntVar(0, maxRoles, `total_${index}`)
    model.addEquality(total, sum(byPerson.get(person.competitor_id) ?? []))
    return total
  })
  const most = model.newIntVar(0, maxRoles, 'max_roles'), least = model.newIntVar(0, maxRoles, 'min_roles')
  model.addMaxEquality(most, totals); model.addMinEquality(least, totals)
  objective.push(most.minus(least).times(-request.options.balance_weight * 1000))
  model.maximize(sum(objective))

  const solver = new CpSolver()
  try {
    const status = await solver.solve(model, { executor: 'direct', maxTimeInSeconds: request.options.time_limit_seconds,
      numWorkers: workerCount, randomSeed: 0 })
    const name = solver.statusName(status)
    if (!['OPTIMAL', 'FEASIBLE', 'INFEASIBLE', 'UNKNOWN', 'MODEL_INVALID'].includes(name)) throw new Error(`不明な計算結果: ${name}`)
    result.status = name as SolveResponse['status']
    if (result.status !== 'OPTIMAL' && result.status !== 'FEASIBLE') {
      result.diagnostics.push(result.status === 'INFEASIBLE'
        ? '制約を同時に満たす割り当てが見つかりませんでした。グループ数、必要人数、免除設定を確認してください。'
        : result.status === 'MODEL_INVALID' ? '計算モデルが不正です。設定を確認してください。'
          : '制限時間内に解が見つかりませんでした。実行時間を増やして再実行してください。')
      return finish()
    }
    const assignment = (person: Competitor, eventId: string, group: number, role: Role): Assignment => ({
      competitor_id: person.competitor_id, name: person.name, wca_id: person.wca_id, age: person.age,
      event_id: eventId, group: group + 1, role,
    })
    const assignments: Assignment[] = []
    for (const event of request.events) for (const person of request.competitors) {
      const group = groups.get(key(person.competitor_id, event.event_id))
      if (group !== undefined) assignments.push(assignment(person, event.event_id, group, 'COMPETITOR'))
    }
    for (const { person, eventId, group, role, variable } of variables) {
      if (solver.value(variable) === 1n) assignments.push(assignment(person, eventId, group, role))
    }
    assignments.sort((a, b) => compareText(a.event_id, b.event_id) || a.group - b.group
      || compareText(a.role, b.role) || compareText(a.competitor_id, b.competitor_id))
    result.validation_errors = validateAssignments(request, assignments)
    if (result.validation_errors.length) {
      result.status = 'MODEL_INVALID'
      result.diagnostics.push('結果検証で制約違反が検出されたため、割り当ての出力を中止しました。')
      return finish()
    }
    result.objective_value = solver.objectiveValue
    result.assignments = assignments
    result.csv_content = exportCsv(request, assignments)
    return finish()
  } finally {
    // Release Emscripten pthread workers; otherwise Node tests cannot exit.
    await terminateLoadedRuntimeThreads()
  }
}
