import assert from 'node:assert/strict'
import test from 'node:test'
import { ApiError, mergeWcaRecords, normalizedWcaId } from '../src/lib/assignments.ts'

const person = {
  competitor_id: '1', name: 'Test competitor', wca_id: '2009ZEMD01', age: 25,
  is_newcomer: false, is_judge_exempt: false, is_scrambler_exempt: false, is_staff: false,
  events: {
    '333': { best_time: null, average_time: 10 },
    '444': { best_time: null, average_time: null },
  },
}

test('WCA IDs are normalized and invalid or absent IDs are skipped', () => {
  assert.equal(normalizedWcaId({ ...person, wca_id: ' 2009zemd01 ' }), '2009ZEMD01')
  for (const id of [null, '', 'TEST0001', '../2009ZEMD01', '2009ZEMD01\nother']) {
    assert.equal(normalizedWcaId({ ...person, wca_id: id }), null)
  }
})

test('default import preserves manual averages and fills only registered events', () => {
  const result = mergeWcaRecords(person, {
    '333': { best_time: 4.12, average_time: 5.53 },
    '444': { best_time: 17.98, average_time: 21.57 },
    '555': { best_time: 36.18, average_time: 40.1 },
  }, false)
  assert.deepEqual(result.person.events, {
    '333': { best_time: 4.12, average_time: 10 },
    '444': { best_time: 17.98, average_time: 21.57 },
  })
  assert.equal(result.updatedEvents, 2)
  assert.equal(person.events['333'].best_time, null)
})

test('explicit overwrite updates existing records', () => {
  const result = mergeWcaRecords(person, { '333': { best_time: 4.12, average_time: 5.53 } }, true)
  assert.equal(result.person.events['333'].average_time, 5.53)
  assert.equal(result.updatedEvents, 1)
})

test('absent official averages never erase manually entered averages', () => {
  const result = mergeWcaRecords(person, { '333': { best_time: 4.12, average_time: null } }, true)
  assert.equal(result.person.events['333'].average_time, 10)
  assert.equal(result.person.events['444'].average_time, null)
})

test('repeated imports do not report unchanged records as updated', () => {
  const result = mergeWcaRecords(person, { '333': { best_time: null, average_time: 10 } }, true)
  assert.equal(result.updatedEvents, 0)
})

test('API status codes remain available to stop on rate limits or server failures', () => {
  const error = new ApiError('Retry later', 429)
  assert.equal(error.status, 429)
  assert.equal(error.message, 'Retry later')
  assert.ok(error instanceof Error)
})
