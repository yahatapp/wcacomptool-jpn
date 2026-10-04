export type PersonalRecord = {
  best_time: number | null
  average_time: number | null
}

export type Competitor = {
  competitor_id: string
  name: string
  wca_id: string | null
  age: number
  is_newcomer: boolean
  is_judge_exempt: boolean
  is_scrambler_exempt: boolean
  is_staff: boolean
  events: Record<string, PersonalRecord>
}

export type EventConfig = {
  event_id: string
  event_name: string
  num_groups: number
  num_scramblers_per_group: number
  use_runners: boolean
  num_runners_per_group: number
}

export type SolverOptions = {
  time_limit_seconds: number
  scrambler_speed_weight: number
  balance_weight: number
  judge_exempt_age: number
}

export type ImportResponse = {
  competition_name: string
  competition_date: string
  competitors: Competitor[]
  events: (EventConfig & { participant_count: number })[]
  excluded_count: number
  warnings: string[]
}

export type SolveRequest = {
  competition_name: string
  competition_date: string
  num_stations: number
  competitors: Competitor[]
  events: EventConfig[]
  options: SolverOptions
}

export const roleLabels = {
  COMPETITOR: '競技者',
  SCRAMBLER: 'スクランブラー',
  JUDGE: 'ジャッジ',
  RUNNER: 'ランナー',
} as const

export type Role = keyof typeof roleLabels

export type Assignment = {
  competitor_id: string
  name: string
  wca_id: string | null
  age: number
  event_id: string
  group: number
  role: Role
}

export type SolveResponse = {
  status: 'OPTIMAL' | 'FEASIBLE' | 'INFEASIBLE' | 'UNKNOWN' | 'MODEL_INVALID'
  solve_time_seconds: number
  objective_value: number | null
  assignments: Assignment[]
  diagnostics: string[]
  warnings: string[]
  validation_errors: string[]
  csv_content: string
}

export type WcaRecordsResponse = {
  wca_id: string
  records: Record<string, PersonalRecord>
  fetched_at: string
  cached: boolean
}

export type ParticipationCheckResponse = {
  passed: boolean
  checked_count: number
  matched_count: number
  issues: {
    kind: 'event_mismatch' | 'missing_participant' | 'unexpected_participant' | 'ambiguous_name'
    name: string
    expected_events: string[]
    actual_events: string[]
    missing_events: string[]
    extra_events: string[]
    message: string
  }[]
}

export const csvCheckLabels = {
  participation: '参加競技の一致',
  newcomers: '初参加者への役割割り当て',
  age: '指定年齢以下の人への役割割り当て',
  staffing: '競技卓数に対するジャッジ人数',
} as const

export type CsvCheckKey = keyof typeof csvCheckLabels
export type CsvCheckSelection = Record<CsvCheckKey, boolean>

export type CsvCheckOptions = CsvCheckSelection & {
  competition_date: string | null
  age_limit: number
  num_stations: number
}

export type CsvCheckIssue = Omit<ParticipationCheckResponse['issues'][number], 'kind'> & {
  kind: ParticipationCheckResponse['issues'][number]['kind'] | 'newcomer_roles' | 'age_roles'
    | 'invalid_birth_date' | 'staffing_shortage'
  assignments: { event_id: string; group: number; role: 'J' | 'S' | 'R' }[]
  age: number | null
  event_id: string | null
  group: number | null
  required_count: number | null
  actual_count: number | null
}

export type CsvCheckResult = {
  key: CsvCheckKey
  passed: boolean
  checked_count: number
  issues: CsvCheckIssue[]
  groups: {
    event_id: string
    group: number
    judge_count: number
    scrambler_count: number
    runner_count: number
    required_count: number
    passed: boolean
  }[]
}

export type CsvCheckResponse = { passed: boolean; checks: CsvCheckResult[] }

export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function readResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const error: unknown = await response.json().catch(() => null)
    const detail = error && typeof error === 'object' && 'detail' in error
      ? error.detail : undefined
    if (typeof detail === 'string') throw new ApiError(detail, response.status)
    if (Array.isArray(detail)) {
      throw new ApiError(detail.map((item: { loc?: (string | number)[]; msg: string }) =>
        `${item.loc?.slice(1).join(' / ') ?? ''}: ${item.msg}`,
      ).join('\n'), response.status)
    }
    throw new ApiError('APIに接続できませんでした。WebとPython APIを一緒に起動してください。', response.status)
  }
  return response.json() as Promise<T>
}

export async function importRegistration(file: File, competitionDate: string) {
  const data = new FormData()
  data.append('file', file)
  data.append('competition_date', competitionDate)
  return readResponse<ImportResponse>(await fetch('/api/import', { method: 'POST', body: data }))
}

export async function solveAssignments(data: SolveRequest) {
  return readResponse<SolveResponse>(await fetch('/api/solve', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  }))
}

export async function checkParticipation(registrationFile: File, resultFile: File) {
  const data = new FormData()
  data.append('registration_file', registrationFile)
  data.append('result_file', resultFile)
  return readResponse<ParticipationCheckResponse>(await fetch('/api/check-participation', {
    method: 'POST', body: data,
  }))
}

export async function checkCsv(
  registrationFile: File | null, resultFile: File, options: CsvCheckOptions,
) {
  const data = new FormData()
  if (registrationFile) data.append('registration_file', registrationFile)
  data.append('result_file', resultFile)
  data.append('options', JSON.stringify(options))
  return readResponse<CsvCheckResponse>(await fetch('/api/check-csv', {
    method: 'POST', body: data,
  }))
}

export async function fetchWcaRecords(wcaId: string, signal: AbortSignal) {
  return readResponse<WcaRecordsResponse>(await fetch(`/api/wca/records/${encodeURIComponent(wcaId)}`, { signal }))
}

export function normalizedWcaId(person: Competitor): string | null {
  const id = person.wca_id?.trim().toUpperCase() ?? ''
  return /^[0-9]{4}[A-Z]{4}[0-9]{2}$/.test(id) ? id : null
}

export function mergeWcaRecords(person: Competitor, records: WcaRecordsResponse['records'], overwrite: boolean) {
  const events = { ...person.events }
  let updatedEvents = 0
  for (const [eventId, current] of Object.entries(person.events)) {
    const fetched = records[eventId]
    if (!fetched) continue
    const next = { ...current }
    for (const key of ['best_time', 'average_time'] as const) {
      // Never remove a manual record when WCA has no official result.
      if (fetched[key] !== null && (overwrite || current[key] === null)) next[key] = fetched[key]
    }
    if (next.best_time !== current.best_time || next.average_time !== current.average_time) {
      events[eventId] = next
      updatedEvents += 1
    }
  }
  return { person: { ...person, events }, updatedEvents }
}

export function downloadCsv(content: string, filename: string) {
  const url = URL.createObjectURL(new Blob(['\uFEFF', content], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
