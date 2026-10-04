import { ApiError } from './assignments.ts'
import type { PersonalRecord, WcaRecordsResponse } from './assignments.ts'
import { EVENT_NAMES } from './competition.ts'

const BASE_URL = 'https://www.worldcubeassociation.org/api/v0/persons'
const CACHE_TTL = 6 * 60 * 60 * 1000
const cache = new Map<string, WcaRecordsResponse>()
const RATE_KEY = 'wca-records-next-request-at'
let nextRequestAt = 0
let queue: Promise<unknown> = Promise.resolve()

export function parseWcaRecords(payload: unknown): Record<string, PersonalRecord> {
  if (!Array.isArray(payload)) throw new ApiError('WCA APIの記録形式が想定と異なります。', 502)
  const records: Record<string, PersonalRecord> = {}
  for (const item of payload) {
    if (!item || typeof item !== 'object' || typeof item.eventId !== 'string' || typeof item.type !== 'string') throw new ApiError('WCA APIの記録形式が想定と異なります。', 502)
    const { eventId, type, best } = item
    if (!Object.hasOwn(EVENT_NAMES, eventId) || eventId === '333mbf' || !['single', 'average'].includes(type)) continue
    if (!Number.isInteger(best)) throw new ApiError('WCA APIから不正な記録値を受け取りました。', 502)
    if (best <= 0) continue
    const value = eventId === '333fm' && type === 'single' ? best : best / 100
    if (value < 0.01 || value > 86400) throw new ApiError('WCA APIから対応範囲外の記録値を受け取りました。', 502)
    const record = records[eventId] ?? { best_time: null, average_time: null }
    record[type === 'average' ? 'average_time' : 'best_time'] = value
    records[eventId] = record
  }
  return records
}

export function retryDelay(value: string | null, fallback: number): number {
  if (!value?.trim()) return fallback
  const numeric = Number(value)
  if (Number.isFinite(numeric)) return Math.max(0, numeric * 1000)
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : fallback
}

function sharedNextRequest(): number {
  try {
    const stored = Number(localStorage.getItem(RATE_KEY))
    return Number.isFinite(stored) ? Math.max(nextRequestAt, stored) : nextRequestAt
  } catch { return nextRequestAt }
}

function deferRequests(until: number) {
  nextRequestAt = Math.max(sharedNextRequest(), until)
  // Only a rate-limit timestamp is stored; participant IDs and records stay in memory.
  try { localStorage.setItem(RATE_KEY, String(nextRequestAt)) } catch { /* Storage may be disabled. */ }
}

function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, milliseconds)
    signal.addEventListener('abort', abort, { once: true })
  })
}

async function fetchOne(id: string, signal: AbortSignal): Promise<WcaRecordsResponse> {
  signal.throwIfAborted()
  const cached = cache.get(id)
  if (cached && Date.now() - Date.parse(cached.fetched_at) < CACHE_TTL) {
    cache.delete(id); cache.set(id, cached)
    return { ...cached, cached: true }
  }
  cache.delete(id)
  for (let attempt = 0; attempt < 3; attempt++) {
    const wait = sharedNextRequest() - Date.now()
    if (wait > 30_000) throw new ApiError('WCA APIから待機を求められています。時間を空けて再実行してください。', 429)
    if (wait > 0) await pause(wait, signal)
    signal.throwIfAborted(); deferRequests(Date.now() + 1000)
    let response: Response
    try {
      response = await fetch(`${BASE_URL}/${id}/personal_records`, {
        headers: { Accept: 'application/json' }, credentials: 'omit', referrerPolicy: 'no-referrer',
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      })
    } catch {
      signal.throwIfAborted(); deferRequests(Date.now() + 2 ** (attempt + 1) * 1000)
      if (attempt < 2) continue
      throw new ApiError('WCA APIに接続できませんでした。ネットワークを確認して再実行してください。', 503)
    }
    if (response.ok) {
      let payload: unknown
      try { payload = await response.json() }
      catch { throw new ApiError('WCA APIの記録を読み取れませんでした。', 502) }
      const result: WcaRecordsResponse = { wca_id: id, records: parseWcaRecords(payload), fetched_at: new Date().toISOString(), cached: false }
      cache.set(id, result)
      if (cache.size > 2000) cache.delete(cache.keys().next().value!)
      return result
    }
    if (response.status === 404) throw new ApiError('WCA IDに対応する参加者が見つかりませんでした。', 404)
    if (response.status === 429 || response.status >= 500) {
      const delay = retryDelay(response.headers.get('Retry-After'), 2 ** (attempt + 1) * 1000)
      deferRequests(Date.now() + delay)
      if (attempt < 2 && delay <= 30_000) continue
      throw new ApiError('WCA APIから待機を求められています。時間を空けて再実行してください。', response.status === 429 ? 429 : 503)
    }
    throw new ApiError(`WCA APIから記録を取得できませんでした（${response.status}）。`, 502)
  }
  throw new ApiError('WCA APIから記録を取得できませんでした。', 503)
}

export async function fetchRecords(id: string, signal: AbortSignal): Promise<WcaRecordsResponse> {
  if (!/^[0-9]{4}[A-Z]{4}[0-9]{2}$/.test(id)) throw new ApiError('WCA IDの形式を確認してください。', 422)
  const run = () => fetchOne(id, signal)
  // Web Locks serialize requests across same-origin tabs as well as within a page.
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request('wca-records-request', { signal }, run)
  }
  const pending = queue.then(run, run)
  queue = pending.catch(() => undefined)
  return pending
}
