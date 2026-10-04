import assert from 'node:assert/strict'
import test from 'node:test'
import { ageOnDate } from '../src/lib/competition.ts'
import { MAX_CSV_BYTES, importRegistrationBytes, readCsvRows } from '../src/lib/registration.ts'
import { checkCsvBytes, checkParticipationBytes, encodeCsv, exportCsv } from '../src/lib/result-csv.ts'
import { bytes, requestData } from './fixtures.mjs'

const header = ['Name', 'WCA ID', 'Birth Date', '333', 'clock', 'Registration Status', 'Registrant Id', 'Email']
const csv = (rows) => bytes('\uFEFF' + encodeCsv([header, ...rows]))
const options = { participation: true, newcomers: true, age: true, staffing: true,
  competition_date: '2026-10-01', age_limit: 12, num_stations: 1 }

test('registration handles BOM, quotes, newlines, statuses and private columns', () => {
  const content = csv([
    ['Name, "quoted"\n日本語', '', '2013-10-02', '1', '0', 'accepted', '1', 'private@example.invalid'],
    ['Pending', '', '2000-01-01', '1', '1', 'pending', '2', 'secret'],
  ])
  const imported = importRegistrationBytes(content, 'Example-registration.csv', '2026-10-01')
  assert.equal(imported.competition_name, 'Example'); assert.equal(imported.excluded_count, 1)
  assert.equal(imported.competitors[0].name, 'Name, "quoted"\n日本語')
  assert.equal(imported.competitors[0].age, 12); assert.equal(imported.competitors[0].is_newcomer, true)
  assert.ok(!JSON.stringify(imported).includes('private@example'))
  assert.equal(ageOnDate('2013-10-02', '2026-10-02'), 13)
  assert.equal(ageOnDate('2000-02-29', '2026-02-28'), 25)
})

test('CSV parsing rejects invalid UTF-8, malformed quotes, columns and file limits', () => {
  for (const input of [bytes('Name,Name\na,b\n'), bytes('Name,333\na,1,2\n'), bytes('Name,333\n"missing,1'), bytes('Name\n"name"trailing'), new Uint8Array([0xff]), new Uint8Array(MAX_CSV_BYTES + 1)]) {
    assert.throws(() => readCsvRows(input))
  }
  assert.throws(() => readCsvRows(bytes('Name\n' + 'Person\n'.repeat(1001))), /1000/)
  assert.throws(() => ageOnDate('2026-02-30', '2026-10-01'))
  assert.throws(() => ageOnDate('2027-01-01', '2026-10-01'))
})

test('export protects names and preserves event and role ordering', () => {
  const request = requestData(); request.competitors = request.competitors.slice(0, 2)
  request.competitors[0].name = '=formula'; request.competitors[1].name = 'Alice (アリス)'
  const assignments = [
    { competitor_id: '1', event_id: '333', group: 4, role: 'RUNNER' },
    { competitor_id: '1', event_id: '333', group: 2, role: 'COMPETITOR' },
    { competitor_id: '1', event_id: '333', group: 3, role: 'JUDGE' },
    { competitor_id: '0', event_id: '333', group: 1, role: 'COMPETITOR' },
  ]
  const exported = exportCsv(request, assignments)
  assert.equal(exported, "Name,333\r\n'=formula,1\r\nAlice,2;J3;R4\r\n")
  assert.equal(exportCsv(request, assignments.toReversed()), exported)
})

test('participation checks distinguish staffing, native-name suffixes and duplicate names', () => {
  const registration = csv([[' Kenya  Yahata (八幡 憲也)', '', '2000-01-01', '1', '0', 'accepted', '1', '']])
  assert.equal(checkParticipationBytes(registration, bytes('Name,333,clock\nKenya Yahata,2;J3,R1\n')).passed, true)
  const mismatch = checkParticipationBytes(registration, bytes('Name,333,clock\nKenya Yahata,J3,2\n'))
  assert.deepEqual(mismatch.issues[0].missing_events, ['333']); assert.deepEqual(mismatch.issues[0].extra_events, ['clock'])
  assert.equal(checkParticipationBytes(registration, bytes('Name,333\nKenya Yahata,1\nKenya Yahata,2\n')).issues[0].kind, 'ambiguous_name')
  assert.throws(() => checkParticipationBytes(registration, bytes('Name,333\nKenya Yahata,1;2\n')), /複数/)
})

test('selected checks include non-competing helpers and count distinct staff per group', () => {
  const registration = csv([
    ['Child', '', '2014-01-01', '1', '0', 'accepted', '1', ''],
    ['Helper', '', '2000-01-01', '0', '0', 'accepted', '2', ''],
  ])
  const checked = checkCsvBytes(registration, bytes('Name,333\nChild,1;J2\nHelper,J1;J1\nHelper,J1\n'), options)
  assert.equal(checked.passed, false)
  assert.equal(checked.checks.find((c) => c.key === 'participation').checked_count, 1)
  assert.ok(checked.checks.find((c) => c.key === 'age').issues.some((i) => i.kind === 'age_roles'))
  assert.ok(checked.checks.find((c) => c.key === 'newcomers').issues.some((i) => i.kind === 'ambiguous_name'))
  assert.equal(checked.checks.find((c) => c.key === 'staffing').groups[0].judge_count, 1)
  assert.ok(checkCsvBytes(null, bytes('Name,333\nA,J1\n'), { ...options, participation: false, newcomers: false, age: false }).passed)
})
