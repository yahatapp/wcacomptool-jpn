import type {
  Assignment, CsvCheckIssue, CsvCheckOptions, CsvCheckResponse, CsvCheckResult,
  ParticipationCheckResponse, SolveRequest,
} from './assignments.ts'
import { ageOnDate, calendarDate, compareText, EVENT_NAMES, key, requireInteger } from './competition.ts'
import { isAccepted, readCsvRows } from './registration.ts'

const prefixes = { COMPETITOR: '', JUDGE: 'J', SCRAMBLER: 'S', RUNNER: 'R' }
const roleOrder = { COMPETITOR: 0, JUDGE: 1, SCRAMBLER: 2, RUNNER: 3 }
export const registrationName = (name: string) => name.split('(', 1)[0].trim()
const csvName = (name: string) => /^[=+\-@]/.test(name.trimStart()) ? `'${name}` : name
const normalizeName = (name: string) => name.trim().replace(/\s+/g, ' ')

export function encodeCsv(rows: string[][]): string {
  return rows.map((row) => row.map((value) => /[",\r\n]/.test(value)
    ? `"${value.replaceAll('"', '""')}"` : value).join(',')).join('\r\n') + '\r\n'
}

export function exportCsv(request: SolveRequest, assignments: Assignment[]): string {
  const cells = new Map<string, Assignment[]>()
  for (const item of assignments) {
    const cell = key(item.competitor_id, item.event_id)
    cells.set(cell, [...(cells.get(cell) ?? []), item])
  }
  return encodeCsv([
    ['Name', ...request.events.map((event) => event.event_id)],
    ...[...request.competitors].sort((a, b) => compareText(a.name, b.name)).map((person) => [
      csvName(registrationName(person.name)),
      ...request.events.map((event) => (cells.get(key(person.competitor_id, event.event_id)) ?? [])
        .sort((a, b) => roleOrder[a.role] - roleOrder[b.role] || a.group - b.group)
        .map((item) => `${prefixes[item.role]}${item.group}`).join(';')),
    ]),
  ])
}

type RegistrationEntry = { name: string; events: Set<string>; wcaId?: string; birthDate?: string }
type ResultEntry = { name: string; events: Set<string>; roles: CsvCheckIssue['assignments']; groups: Map<string, number>; competitorGroups: Map<string, number> }

function readRegistrations(content: Uint8Array, includeWithoutEvents = false): RegistrationEntry[] {
  const { columns, rows } = readCsvRows(content)
  if (!columns.includes('Name')) throw new Error('登録CSVに必要な列がありません: Name')
  if (!columns.includes('Registration Status') && !columns.includes('Status')) throw new Error('登録CSVにRegistration Status または Status 列が必要です。')
  const eventIds = columns.filter((column) => Object.hasOwn(EVENT_NAMES, column))
  if (!eventIds.length) throw new Error('登録CSVにWCAの競技列（333、444など）が見つかりません。')
  const participants: RegistrationEntry[] = []
  for (const [index, row] of rows.entries()) {
    if (!isAccepted(row)) continue
    const name = row.Name.trim()
    if (!registrationName(name)) throw new Error(`登録CSVの${index + 2}行目: 英語名は必須です。`)
    const events = new Set<string>()
    for (const eventId of eventIds) {
      const value = row[eventId].trim()
      if (!['0', '1', ''].includes(value)) throw new Error(`登録CSVの${index + 2}行目: ${eventId}列は0または1で指定してください。`)
      if (value === '1') events.add(eventId)
    }
    if (events.size || includeWithoutEvents) participants.push({ name, events, wcaId: row['WCA ID'], birthDate: row['Birth Date'] })
  }
  if (!participants.length) throw new Error('参加競技がある承認済み参加者が見つかりません。')
  return participants
}

function readResults(content: Uint8Array) {
  const { columns, rows } = readCsvRows(content)
  if (!columns.includes('Name')) throw new Error('結果CSVに必要な列がありません: Name')
  const eventIds = columns.filter((column) => column !== 'Name')
  if (!eventIds.length || eventIds.some((id) => !Object.hasOwn(EVENT_NAMES, id))) throw new Error('結果CSVはName列とWCA競技IDの列（333、444など）で指定してください。')
  const participants: ResultEntry[] = []
  for (const [index, row] of rows.entries()) {
    const name = row.Name.trim()
    if (!name) throw new Error(`結果CSVの${index + 2}行目: 名前は必須です。`)
    const events = new Set<string>(), roles: ResultEntry['roles'] = [], groups = new Map<string, number>()
    const competitorGroups = new Map<string, number>()
    for (const eventId of eventIds) {
      const cell = row[eventId].trim()
      if (!cell) continue
      let competitorGroupCount = 0
      for (const token of cell.split(';')) {
        const match = /^([JSR]?)([1-9][0-9]*)$/.exec(token.trim())
        if (!match) throw new Error(`結果CSVの${index + 2}行目（${name}）、${eventId}列: 数字またはJ・S・Rと数字をセミコロンで区切ってください。`)
        const group = Number(match[2])
        if (match[2].length > 3 || group > 100) throw new Error(`結果CSVの${index + 2}行目（${name}）、${eventId}列: グループ番号は1〜100で指定してください。`)
        groups.set(eventId, Math.max(groups.get(eventId) ?? 0, group))
        if (match[1]) roles.push({ event_id: eventId, group, role: match[1] as 'J' | 'S' | 'R' })
        else { competitorGroupCount++; events.add(eventId); competitorGroups.set(eventId, group) }
      }
      if (competitorGroupCount > 1) throw new Error(`結果CSVの${index + 2}行目（${name}）、${eventId}列: 競技グループが複数あります。数字のみの項目は1つにしてください。`)
    }
    participants.push({ name, events, roles, groups, competitorGroups })
  }
  return { eventIds, participants }
}

function byName<T extends { name: string }>(people: T[], registered: boolean) {
  const grouped = new Map<string, T[]>()
  for (const person of people) {
    const name = normalizeName(registered ? csvName(registrationName(person.name)) : person.name)
    grouped.set(name, [...(grouped.get(name) ?? []), person])
  }
  return grouped
}

function compareParticipation(registrations: RegistrationEntry[], results: ResultEntry[]): ParticipationCheckResponse {
  const expected = byName(registrations, true), actual = byName(results, false)
  const issues: ParticipationCheckResponse['issues'] = []
  let matched = 0
  for (const nameKey of [...new Set([...expected.keys(), ...actual.keys()])].sort(compareText)) {
    const input = expected.get(nameKey) ?? [], output = actual.get(nameKey) ?? []
    const name = (input[0] ?? output[0]).name
    const base = { name, expected_events: [], actual_events: [], missing_events: [], extra_events: [] }
    if (input.length > 1 || output.length > 1) {
      issues.push({ ...base, kind: 'ambiguous_name', message: `同名の行があり照合できません（登録CSV ${input.length}行、結果CSV ${output.length}行）。名前を区別して再チェックしてください。` }); continue
    }
    const registered = input[0]?.events ?? new Set<string>(), assigned = output[0]?.events ?? new Set<string>()
    const missing = [...registered].filter((id) => !assigned.has(id)), extra = [...assigned].filter((id) => !registered.has(id))
    if (input.length && output.length && !missing.length && !extra.length) { matched++; continue }
    const kind = !input.length ? 'unexpected_participant' : !output.length ? 'missing_participant' : 'event_mismatch'
    const message = kind === 'unexpected_participant' ? '結果CSVにのみ存在します。承認済みの登録に見つかりません。'
      : kind === 'missing_participant' ? '登録CSVに存在しますが、結果CSVに行がありません。' : '入力CSVと結果CSVの参加競技が一致していません。'
    issues.push({ kind, name, message, expected_events: [...registered].sort(compareText), actual_events: [...assigned].sort(compareText),
      missing_events: missing.sort(compareText), extra_events: extra.sort(compareText) })
  }
  return { passed: !issues.length, checked_count: registrations.length, matched_count: matched, issues }
}

export function checkParticipationBytes(registration: Uint8Array, result: Uint8Array): ParticipationCheckResponse {
  return compareParticipation(readRegistrations(registration), readResults(result).participants)
}

function issue(data: Pick<CsvCheckIssue, 'kind' | 'name' | 'message'> & Partial<CsvCheckIssue>): CsvCheckIssue {
  return { expected_events: [], actual_events: [], missing_events: [], extra_events: [], assignments: [],
    age: null, event_id: null, group: null, required_count: null, actual_count: null, ...data }
}

function checkPersonRoles(check: 'age' | 'newcomers', registrations: RegistrationEntry[], results: ResultEntry[], options: CsvCheckOptions): CsvCheckResult {
  const expected = byName(registrations, true), actual = byName(results, false), issues: CsvCheckIssue[] = []
  for (const [nameKey, output] of actual) {
    const roles = output.flatMap((person) => person.roles)
    if (!roles.length) continue
    const input = expected.get(nameKey) ?? [], name = (input[0] ?? output[0]).name
    const base = { name, assignments: roles }
    if (input.length > 1 || output.length > 1) { issues.push(issue({ ...base, kind: 'ambiguous_name', message: '同名の行があるため、役割を担当する人を特定できません。' })); continue }
    if (!input.length) { issues.push(issue({ ...base, kind: 'unexpected_participant', message: '役割がありますが、承認済みの登録に見つからず判定できません。' })); continue }
    if (check === 'newcomers') {
      if (!input[0].wcaId?.trim()) issues.push(issue({ ...base, kind: 'newcomer_roles', message: '初参加者（WCA IDなし）に役割が割り当たっています。' }))
    } else {
      let age: number
      try { age = ageOnDate(input[0].birthDate ?? '', options.competition_date!) }
      catch (error) { issues.push(issue({ ...base, kind: 'invalid_birth_date', message: `年齢を判定できません: ${(error as Error).message}` })); continue }
      if (age <= options.age_limit) issues.push(issue({ ...base, kind: 'age_roles', age, message: `${age}歳（${options.age_limit}歳以下）の人に役割が割り当たっています。` }))
    }
  }
  return { key: check, passed: !issues.length, checked_count: results.length, issues, groups: [] }
}

function checkStaffing(eventIds: string[], results: ResultEntry[], stations: number): CsvCheckResult {
  const maxGroups = new Map<string, number>(), counts = new Map<string, Set<string>>()
  function countPerson(eventId: string, group: number, role: string, name: string) {
    const roleKey = key(eventId, group, role), people = counts.get(roleKey) ?? new Set<string>()
    people.add(normalizeName(name)); counts.set(roleKey, people)
  }
  for (const person of results) {
    for (const [event, group] of person.groups) maxGroups.set(event, Math.max(maxGroups.get(event) ?? 0, group))
    for (const [event, group] of person.competitorGroups) countPerson(event, group, '', person.name)
    for (const role of person.roles) countPerson(role.event_id, role.group, role.role, person.name)
  }
  const issues: CsvCheckIssue[] = [], groups: CsvCheckResult['groups'] = []
  for (const eventId of eventIds) {
    for (let group = 1; group <= Math.max(maxGroups.get(eventId) ?? 0, 1); group++) {
      const competitors = counts.get(key(eventId, group, ''))?.size ?? 0
      const judges = counts.get(key(eventId, group, 'J'))?.size ?? 0
      const required = Math.min(competitors, stations)
      groups.push({ event_id: eventId, group, competitor_count: competitors, judge_count: judges,
        scrambler_count: counts.get(key(eventId, group, 'S'))?.size ?? 0, runner_count: counts.get(key(eventId, group, 'R'))?.size ?? 0,
        required_count: required, passed: judges >= required })
      if (judges < required) issues.push(issue({ kind: 'staffing_shortage', name: `${eventId} G${group}`, event_id: eventId, group,
        required_count: required, actual_count: judges, message: `ジャッジ${judges}人 / 必要${required}人 （競技者${competitors}人・競技卓${stations}卓、${required - judges}人不足）。` }))
    }
  }
  return { key: 'staffing', passed: !issues.length, checked_count: groups.length, issues, groups }
}

export function checkCsvBytes(registration: Uint8Array | null, result: Uint8Array, options: CsvCheckOptions): CsvCheckResponse {
  if (![options.participation, options.newcomers, options.age, options.staffing].some(Boolean)) throw new Error('チェック項目を1つ以上選択してください。')
  requireInteger(options.age_limit, 0, 120, '年齢')
  requireInteger(options.num_stations, 1, 100, '競技卓数')
  if (options.age) {
    if (!options.competition_date) throw new Error('年齢チェックには大会日が必要です。')
    calendarDate(options.competition_date)
  }
  const { eventIds, participants: results } = readResults(result)
  let registrations: RegistrationEntry[] = []
  if (options.participation || options.age || options.newcomers) {
    if (!registration) throw new Error('選択したチェックには登録CSVが必要です。')
    registrations = readRegistrations(registration, options.age || options.newcomers)
  }
  if (options.newcomers && registrations.some((person) => person.wcaId === undefined)) throw new Error('初参加者チェックには登録CSVのWCA ID列が必要です。')
  if (options.age && registrations.some((person) => person.birthDate === undefined)) throw new Error('年齢チェックには登録CSVのBirth Date列が必要です。')
  const checks: CsvCheckResult[] = []
  if (options.participation) {
    const checked = compareParticipation(registrations.filter((person) => person.events.size), results)
    checks.push({ key: 'participation', passed: checked.passed, checked_count: checked.checked_count, issues: checked.issues.map(issue), groups: [] })
  }
  if (options.newcomers) checks.push(checkPersonRoles('newcomers', registrations, results, options))
  if (options.age) checks.push(checkPersonRoles('age', registrations, results, options))
  if (options.staffing) checks.push(checkStaffing(eventIds, results, options.num_stations))
  return { passed: checks.every((check) => check.passed), checks }
}
