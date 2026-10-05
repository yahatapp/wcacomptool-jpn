import assert from 'node:assert/strict'
import test from 'node:test'
import { solve, assignGroups, validateAssignments } from '../src/lib/solver.ts'
import { key } from '../src/lib/competition.ts'
import { requestData } from './fixtures.mjs'

test('WASM CP-SAT covers every role and respects exemptions, breaks and exclusivity', async () => {
  const request = requestData()
  request.competitors[0].is_staff = true
  request.competitors[1].age = 12
  request.competitors[4].is_newcomer = true
  request.competitors[7].is_judge_exempt = true
  request.competitors[10].is_scrambler_exempt = true
  request.events[0].use_runners = true; request.events[0].num_runners_per_group = 1
  const result = await solve(request)
  assert.ok(['OPTIMAL', 'FEASIBLE'].includes(result.status), JSON.stringify(result))
  assert.deepEqual(result.validation_errors, [])
  const occupied = new Set(), counts = new Map(), groups = assignGroups(request)
  for (const item of result.assignments) {
    const slot = key(item.competitor_id, item.event_id, item.group)
    assert.ok(!occupied.has(slot)); occupied.add(slot)
    const counter = key(item.group, item.role)
    counts.set(counter, (counts.get(counter) ?? 0) + 1)
    const person = request.competitors.find((p) => p.competitor_id === item.competitor_id)
    if (item.role !== 'COMPETITOR') {
      assert.equal(person.is_staff, false)
      const own = groups.get(key(item.competitor_id, item.event_id)) + 1
      assert.ok(![own, own - 1].includes(item.group))
    }
    if (item.role === 'JUDGE') assert.ok(person.age > 12 && !person.is_newcomer && !person.is_judge_exempt)
    if (item.role === 'SCRAMBLER') assert.equal(person.is_scrambler_exempt, false)
  }
  for (let group = 1; group <= 4; group++) for (const [role, needed] of Object.entries({ COMPETITOR: 3, JUDGE: 3, SCRAMBLER: 1, RUNNER: 1 })) {
    assert.equal(counts.get(key(group, role)), needed)
  }
  assert.equal(result.csv_content.trim().split('\r\n').length, 13)
})

test('speed objective selects the fastest eligible scrambler without balancing', async () => {
  const request = requestData(); request.options.balance_weight = 0
  const result = await solve(request), groups = assignGroups(request)
  assert.equal(result.status, 'OPTIMAL')
  for (const item of result.assignments.filter((a) => a.role === 'SCRAMBLER')) {
    const candidates = request.competitors.filter((p) => {
      const own = groups.get(key(p.competitor_id, '333')) + 1
      return ![own, own - 1].includes(item.group)
    })
    assert.equal(item.competitor_id, candidates.sort((a, b) => a.events['333'].average_time - b.events['333'].average_time)[0].competitor_id)
  }
})

test('insufficient and overlapping candidates never produce a partial CSV', async () => {
  const request = requestData(); request.competitors = request.competitors.slice(0, 1); request.events[0].num_groups = 1
  const empty = await solve(request)
  assert.equal(empty.status, 'INFEASIBLE'); assert.equal(empty.csv_content, ''); assert.deepEqual(empty.assignments, [])
  assert.ok(empty.diagnostics.some((m) => m.includes('候補者は0人')))
  const overlapping = requestData(); overlapping.events[0].num_groups = 2
  const result = await solve(overlapping)
  assert.equal(result.status, 'INFEASIBLE')
  assert.ok(result.diagnostics.some((m) => m.includes('兼任不可')))
})

test('missing averages preserve input order and warn about waiting seats', async () => {
  const request = requestData(); request.num_stations = 2
  for (const person of request.competitors) person.events['333'].average_time = null
  const groups = assignGroups(request)
  assert.deepEqual(request.competitors.map((p) => groups.get(key(p.competitor_id, '333'))), [0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3])
  const result = await solve(request)
  assert.ok(['OPTIMAL', 'FEASIBLE'].includes(result.status))
  assert.ok(result.warnings.some((m) => m.includes('平均記録が未入力')))
  assert.ok(result.warnings.some((m) => m.includes('待機席')))
})

test('judge counts use the smaller of each group size and station count', async () => {
  for (const stations of [2, 3, 4]) {
    const request = requestData(); request.num_stations = stations; request.competitors.pop()
    const result = await solve(request)
    assert.ok(['OPTIMAL', 'FEASIBLE'].includes(result.status), JSON.stringify(result))
    assert.deepEqual(validateAssignments(request, result.assignments), [])
    for (const [index, size] of [3, 3, 3, 2].entries()) {
      const assignments = result.assignments.filter((item) => item.group === index + 1)
      assert.equal(assignments.filter((item) => item.role === 'COMPETITOR').length, size)
      assert.equal(assignments.filter((item) => item.role === 'JUDGE').length, Math.min(size, stations))
      assert.equal(assignments.filter((item) => item.role === 'SCRAMBLER').length, 1)
    }
    assert.ok(validateAssignments(request, result.assignments.filter((item) => item.role !== 'JUDGE')).some((m) => m.includes('ジャッジの必要人数')))
  }
})

test('the station cap permits previously understaffed groups and rejects excess generated judges', async () => {
  const request = requestData(); request.events[0].num_groups = 3
  const result = await solve(request)
  assert.ok(['OPTIMAL', 'FEASIBLE'].includes(result.status), JSON.stringify(result))
  for (let group = 1; group <= 3; group++) {
    assert.equal(result.assignments.filter((item) => item.group === group && item.role === 'COMPETITOR').length, 4)
    assert.equal(result.assignments.filter((item) => item.group === group && item.role === 'JUDGE').length, 3)
  }
  const occupied = new Set(result.assignments.filter((item) => item.group === 3).map((item) => item.competitor_id))
  const extra = result.assignments.find((item) => item.role === 'COMPETITOR' && item.group < 3 && !occupied.has(item.competitor_id))
  assert.deepEqual(validateAssignments(request, [...result.assignments, { ...extra, group: 3, role: 'JUDGE' }]), ['333 G3: ジャッジの必要人数を満たしていません。'])
})

test('independent validation detects omitted roles, duplicates, altered groups and age exemptions', async () => {
  const request = requestData(), result = await solve(request)
  assert.deepEqual(validateAssignments(request, result.assignments), [])
  assert.ok(validateAssignments(request, result.assignments.filter((item) => item.role !== 'JUDGE')).some((m) => m.includes('必要人数')))
  assert.ok(validateAssignments(request, [...result.assignments, result.assignments[0]]).some((m) => m.includes('兼任')))
  const altered = structuredClone(result.assignments), competing = altered.find((item) => item.role === 'COMPETITOR')
  competing.group = competing.group === 1 ? 2 : 1
  assert.ok(validateAssignments(request, altered).some((m) => m.includes('一致')))
  request.options.judge_exempt_age = 25
  assert.ok(validateAssignments(request, result.assignments).some((m) => m.includes('資格制約')))
  assert.equal((await solve(request)).status, 'INFEASIBLE')
})

test('invalid inputs are rejected before loading or solving', async () => {
  for (const mutate of [
    (r) => { r.competitors[0].events['333'].average_time = NaN },
    (r) => { r.options.balance_weight = Infinity },
    (r) => { r.competitors[1].competitor_id = r.competitors[0].competitor_id },
    (r) => { r.events[0].num_groups = 13 },
    (r) => { r.competition_date = '2026-02-30' },
  ]) {
    const request = requestData(); mutate(request)
    await assert.rejects(solve(request))
  }
})
