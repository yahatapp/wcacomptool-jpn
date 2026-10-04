import type { SolveRequest } from './assignments.ts'

export const EVENT_NAMES: Record<string, string> = {
  '333': '3x3x3', '222': '2x2x2', '444': '4x4x4', '555': '5x5x5',
  '666': '6x6x6', '777': '7x7x7', '333bf': '3x3x3 目隠し',
  '333fm': '3x3x3 最少手数', '333oh': '3x3x3 片手', clock: 'クロック',
  minx: 'メガミンクス', pyram: 'ピラミンクス', skewb: 'スキューブ',
  sq1: 'スクエア1', '444bf': '4x4x4 目隠し', '555bf': '5x5x5 目隠し',
  '333mbf': '3x3x3 複数目隠し',
}

export const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
export const key = (...values: (string | number)[]) => JSON.stringify(values)

export function requireInteger(value: number, min: number, max: number, label: string) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label}は${min}〜${max}の整数で指定してください。`)
  }
}

// Parse calendar dates without the browser's timezone or Date's overflow normalization.
export function calendarDate(text: string): [number, number, number] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error('日付はYYYY-MM-DD形式で必要です。')
  const [year, month, day] = text.split('-').map(Number)
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]) {
    throw new Error('日付を確認してください。')
  }
  return [year, month, day]
}

export function ageOnDate(birthText: string, competitionDate: string): number {
  let birth: [number, number, number]
  try { birth = calendarDate(birthText.trim()) }
  catch { throw new Error('生年月日はYYYY-MM-DD形式で必要です。') }
  const [year, month, day] = calendarDate(competitionDate)
  const [birthYear, birthMonth, birthDay] = birth
  const age = year - birthYear - Number(month < birthMonth || (month === birthMonth && day < birthDay))
  if (age < 0 || age > 120) throw new Error('生年月日または大会日を確認してください。')
  return age
}

export function validateSolveRequest(request: SolveRequest) {
  calendarDate(request.competition_date)
  if (!request.competition_name.trim() || request.competition_name.length > 200) {
    throw new Error('大会名は1〜200文字で指定してください。')
  }
  requireInteger(request.num_stations, 1, 100, '競技卓数')
  requireInteger(request.events.length, 1, 17, '競技数')
  requireInteger(request.competitors.length, 1, 1000, '参加者数')
  const { options } = request
  if (!Number.isFinite(options.time_limit_seconds) || options.time_limit_seconds < 1 || options.time_limit_seconds > 120) {
    throw new Error('制限時間は1〜120秒で指定してください。')
  }
  requireInteger(options.scrambler_speed_weight, 0, 1000, '速度優先の重み')
  requireInteger(options.balance_weight, 0, 1000, '負荷均等化の重み')
  requireInteger(options.judge_exempt_age, 0, 120, 'ジャッジ免除の年齢')
  const eventIds = new Set(request.events.map((event) => event.event_id))
  if (eventIds.size !== request.events.length) throw new Error('競技IDが重複しています。')
  const personIds = new Set<string>()
  for (const person of request.competitors) {
    if (!person.competitor_id || person.competitor_id.length > 100 || personIds.has(person.competitor_id)) {
      throw new Error('参加者IDが空欄・重複、または100文字を超えています。')
    }
    personIds.add(person.competitor_id)
    if (!person.name || person.name.length > 300) throw new Error('名前は1〜300文字で指定してください。')
    requireInteger(person.age, 0, 120, `${person.name}の年齢`)
    const registrations = Object.entries(person.events)
    if (!registrations.length || registrations.some(([id]) => !eventIds.has(id))) {
      throw new Error('参加者の参加競技と競技設定が一致していません。')
    }
    for (const [, record] of registrations) {
      for (const value of [record.best_time, record.average_time]) {
        if (value !== null && (!Number.isFinite(value) || value < 0.01 || value > 86400)) {
          throw new Error(`${person.name}: 記録は0.01〜86400の値または空欄で指定してください。`)
        }
      }
    }
  }
  for (const event of request.events) {
    if (!Object.hasOwn(EVENT_NAMES, event.event_id)) throw new Error(`未対応の競技ID: ${event.event_id}`)
    requireInteger(event.num_groups, 1, 100, 'グループ数')
    requireInteger(event.num_scramblers_per_group, 0, 100, 'スクランブラー数')
    requireInteger(event.num_runners_per_group, 0, 100, 'ランナー数')
    if (!event.use_runners && event.num_runners_per_group) throw new Error('ランナーを使わない場合、ランナー人数は0にしてください。')
    const count = request.competitors.filter((person) => Object.hasOwn(person.events, event.event_id)).length
    if (count === 0 || event.num_groups > count) {
      throw new Error(`${event.event_name}: グループ数は参加者数（${count}人）以下にしてください。`)
    }
  }
}
