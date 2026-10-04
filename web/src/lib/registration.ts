import type { Competitor, ImportResponse } from './assignments.ts'
import { ageOnDate, calendarDate, compareText, EVENT_NAMES } from './competition.ts'

export const MAX_CSV_BYTES = 5 * 1024 * 1024
const MAX_ROWS = 1000

export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [], field = '', state: 'start' | 'plain' | 'quoted' | 'closed' = 'start'
  let touched = false
  const fieldEnd = () => { row.push(field); field = ''; state = 'start' }
  const rowEnd = () => {
    if (touched || row.length || field) { fieldEnd(); rows.push(row) }
    row = []; touched = false
    if (rows.length > MAX_ROWS + 1) throw new Error('CSVの参加者は1000人以下にしてください。')
  }
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (state === 'quoted') {
      if (char === '"') {
        if (text[index + 1] === '"') { field += '"'; index++ }
        else state = 'closed'
      } else field += char
      continue
    }
    if (char === ',') { touched = true; fieldEnd(); continue }
    if (char === '\r' || char === '\n') {
      rowEnd()
      if (char === '\r' && text[index + 1] === '\n') index++
      continue
    }
    if (state === 'closed') throw new Error('CSVの引用符や改行の形式を確認してください。')
    touched = true
    if (state === 'start' && char === '"') state = 'quoted'
    else { field += char; state = 'plain' }
  }
  if (state === 'quoted') throw new Error('CSVの引用符や改行の形式を確認してください。')
  rowEnd()
  return rows
}

export function readCsvRows(content: Uint8Array) {
  if (content.byteLength > MAX_CSV_BYTES) throw new Error('CSVは5MB以下にしてください。')
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(content) }
  catch { throw new Error('UTF-8形式のCSVをアップロードしてください。') }
  const [columns = [], ...values] = parseCsv(text)
  if (new Set(columns).size !== columns.length) throw new Error('CSVの列名が重複しています。')
  const rows = values.map((row, index) => {
    if (row.length !== columns.length) throw new Error(`${index + 2}行目: 列数がヘッダーと一致していません。`)
    return Object.fromEntries(columns.map((column, i) => [column, row[i]]))
  })
  return { columns, rows }
}

export async function readCsvFile(file: File): Promise<Uint8Array> {
  if (file.size > MAX_CSV_BYTES) throw new Error('CSVは5MB以下にしてください。')
  return new Uint8Array(await file.arrayBuffer())
}

export function isAccepted(row: Record<string, string>): boolean {
  const status = (row['Registration Status'] ?? '').trim().toLowerCase()
  return status ? status === 'accepted' : (row.Status ?? '').trim() === 'a'
}

export function importRegistrationBytes(content: Uint8Array, filename: string, competitionDate: string): ImportResponse {
  calendarDate(competitionDate)
  const { columns, rows } = readCsvRows(content)
  const missing = ['Name', 'WCA ID', 'Birth Date'].filter((column) => !columns.includes(column))
  if (missing.length) throw new Error(`CSVに必要な列がありません: ${missing.sort(compareText).join(', ')}`)
  if (!columns.includes('Registration Status') && !columns.includes('Status')) throw new Error('Registration Status または Status 列が必要です。')
  const idColumn = ['Registrant Id', 'User Id'].find((column) => columns.includes(column))
  if (!idColumn) throw new Error('Registrant Id または User Id 列が必要です。')
  const eventIds = columns.filter((column) => Object.hasOwn(EVENT_NAMES, column))
  if (!eventIds.length) throw new Error('WCAの競技列（333、444など）が見つかりません。')
  const competitors: Competitor[] = [], warnings: string[] = [], seenIds = new Set<string>()
  let excludedCount = 0
  for (const [index, row] of rows.entries()) {
    if (!isAccepted(row)) { excludedCount++; continue }
    const id = row[idColumn].trim(), name = row.Name.trim()
    if (!id || !name) throw new Error(`${index + 2}行目: 参加者IDと名前は必須です。`)
    if (seenIds.has(id)) throw new Error(`${index + 2}行目: 参加者IDが重複しています。`)
    if (id.length > 100 || name.length > 300) throw new Error(`${index + 2}行目: 参加者IDは100文字、名前は300文字以下にしてください。`)
    seenIds.add(id)
    let age: number
    try { age = ageOnDate(row['Birth Date'], competitionDate) }
    catch (error) { throw new Error(`${index + 2}行目: ${(error as Error).message}`) }
    const events: Competitor['events'] = {}
    for (const eventId of eventIds) {
      const value = row[eventId].trim()
      if (!['0', '1', ''].includes(value)) throw new Error(`${index + 2}行目: ${eventId}列は0または1で指定してください。`)
      if (value === '1') events[eventId] = { best_time: null, average_time: null }
    }
    if (!Object.keys(events).length) {
      warnings.push(`${index + 2}行目は参加競技がないため除外しました。`); excludedCount++; continue
    }
    const wcaId = row['WCA ID'].trim() || null
    competitors.push({ competitor_id: id, name, age, wca_id: wcaId, is_newcomer: wcaId === null,
      is_judge_exempt: false, is_scrambler_exempt: false, is_staff: false, events })
  }
  if (!competitors.length) throw new Error('参加競技がある承認済み参加者が見つかりません。')
  const events: ImportResponse['events'] = []
  for (const eventId of eventIds) {
    const count = competitors.filter((person) => Object.hasOwn(person.events, eventId)).length
    if (count) events.push({ event_id: eventId, event_name: EVENT_NAMES[eventId], participant_count: count,
      num_groups: Math.min(4, count), num_scramblers_per_group: 1, use_runners: false, num_runners_per_group: 0 })
  }
  warnings.push('ベスト・平均タイムはCSVに含まれていません。未入力の場合、速度順の評価は行いません。',
    '初参加はWCA IDの有無から推定しています。免除・運営専任フラグと合わせて確認してください。',
    'グループ数とスクランブラー数は仮設定です。大会の運営計画に合わせて変更してください。')
  const stem = filename.split(/[\\/]/).at(-1)!.replace(/\.[^.]*$/, '')
  return { competition_name: stem.replace(/-registration$/, ''), competition_date: competitionDate,
    competitors, events, excluded_count: excludedCount, warnings }
}
