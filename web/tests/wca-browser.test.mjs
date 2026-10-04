import assert from 'node:assert/strict'
import test from 'node:test'
import { fetchRecords, parseWcaRecords, retryDelay } from '../src/lib/wca-records.ts'

test('official record units, missing averages and unsupported events are handled', () => {
  assert.deepEqual(parseWcaRecords([
    { eventId: '333', type: 'single', best: 412 },
    { eventId: '333', type: 'average', best: 553 },
    { eventId: '444', type: 'single', best: 1798 },
    { eventId: '444', type: 'average', best: -1 },
    { eventId: '333fm', type: 'single', best: 18 },
    { eventId: '333fm', type: 'average', best: 2233 },
    { eventId: '333mbf', type: 'single', best: 320123401 },
  ]), {
    '333': { best_time: 4.12, average_time: 5.53 },
    '444': { best_time: 17.98, average_time: null },
    '333fm': { best_time: 18, average_time: 22.33 },
  })
  assert.throws(() => parseWcaRecords({}), /記録形式/)
  assert.throws(() => parseWcaRecords([{ eventId: '333', type: 'average', best: '553' }]), /不正な記録値/)
})

test('Retry-After supports both seconds and HTTP dates', (t) => {
  const now = Date.parse('2026-10-04T00:00:00Z')
  t.mock.method(Date, 'now', () => now)
  assert.equal(retryDelay('3', 2000), 3000)
  assert.equal(retryDelay('Sun, 04 Oct 2026 00:00:05 GMT', 2000), 5000)
  assert.equal(retryDelay('invalid', 2000), 2000)
})

test('records are fetched directly without credentials and reused from memory', async (t) => {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options })
    return Response.json([{ eventId: '333', type: 'average', best: 553 }])
  })
  const signal = new AbortController().signal
  const first = await fetchRecords('2009ZEMD01', signal)
  const second = await fetchRecords('2009ZEMD01', signal)
  assert.equal(first.cached, false)
  assert.equal(second.cached, true)
  assert.deepEqual(first.records, second.records)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://www.worldcubeassociation.org/api/v0/persons/2009ZEMD01/personal_records')
  assert.equal(calls[0].options.credentials, 'omit')
  assert.equal(calls[0].options.referrerPolicy, 'no-referrer')
})

test('invalid IDs and cancelled requests do not reach WCA', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('unexpected request') })
  await assert.rejects(fetchRecords('../2009ZEMD01', new AbortController().signal), { status: 422 })
  await assert.rejects(fetchRecords('2015TEST01', AbortSignal.abort()), { name: 'AbortError' })
  assert.equal(fetch.mock.callCount(), 0)
})

test('rate-limit retries retain status codes and a missing person is reported', async (t) => {
  let requests = 0
  t.mock.method(globalThis, 'fetch', async () => {
    requests++
    return new Response('', { status: 429, headers: { 'Retry-After': '0' } })
  })
  await assert.rejects(fetchRecords('2015TEST02', new AbortController().signal), { status: 429 })
  assert.equal(requests, 3)
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 404 }))
  await assert.rejects(fetchRecords('2015TEST03', new AbortController().signal), { status: 404 })
})
