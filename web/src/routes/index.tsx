import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { Check, Download, FlaskConical, LoaderCircle, Play, Upload } from 'lucide-react'
import ParticipationCheck from '../components/ParticipationCheck'
import { Button } from '../components/ui/button'
import { Card } from '../components/ui/card'
import { Input } from '../components/ui/input'
import {
  ApiError, downloadCsv, fetchWcaRecords, importRegistration, mergeWcaRecords,
  normalizedWcaId, roleLabels, solveAssignments,
} from '../lib/assignments'
import type {
  Competitor, EventConfig, ImportResponse, PersonalRecord, Role, SolveResponse, SolverOptions,
} from '../lib/assignments'

export const Route = createFileRoute('/')({ component: AssignmentPage })

type RecordProgress = {
  total: number
  completed: number
  cached: number
  updatedEvents: number
  missingAverages: number
  currentId: string
  failures: string[]
  stopped: boolean
}

function NumberInput({ label, value, onChange, min = 0, max = 100, step = 1 }: {
  label: string
  value: number | null
  onChange: (value: number | null) => void
  min?: number
  max?: number
  step?: number
}) {
  return <Input
    className="assignment-input number-input" type="number" aria-label={label}
    min={min} max={max} step={step} value={value ?? ''}
    onChange={(event) => onChange(event.target.value === '' ? null : Number(event.target.value))}
  />
}

function Notice({ children, danger = false }: { children: ReactNode; danger?: boolean }) {
  return <div className={`assignment-notice ${danger ? 'assignment-notice-danger' : ''}`}
    role={danger ? 'alert' : 'status'}>{children}</div>
}

function AssignmentPage() {
  const fileInput = useRef<HTMLInputElement>(null)
  const recordsControl = useRef<{ stop: boolean; controller: AbortController } | null>(null)
  const solverControl = useRef<AbortController | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [browserReady, setBrowserReady] = useState(false)
  const [competitionDate, setCompetitionDate] = useState('')
  const [competitionName, setCompetitionName] = useState('')
  const [numStations, setNumStations] = useState(20)
  const [imported, setImported] = useState<ImportResponse | null>(null)
  const [events, setEvents] = useState<EventConfig[]>([])
  const [competitors, setCompetitors] = useState<Competitor[]>([])
  const [options, setOptions] = useState<SolverOptions>({
    time_limit_seconds: 30, scrambler_speed_weight: 100, balance_weight: 50, judge_exempt_age: 12,
  })
  const [busy, setBusy] = useState<'import' | 'solve' | 'records' | null>(null)
  const [overwriteRecords, setOverwriteRecords] = useState(false)
  const [recordProgress, setRecordProgress] = useState<RecordProgress | null>(null)
  const [recordsStopping, setRecordsStopping] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<SolveResponse | null>(null)
  const [participantSearch, setParticipantSearch] = useState('')
  const [recordEvent, setRecordEvent] = useState('')
  const [resultEvent, setResultEvent] = useState('')
  const [resultSearch, setResultSearch] = useState('')

  useEffect(() => {
    setBrowserReady(true)
    return () => {
      recordsControl.current?.controller.abort()
      solverControl.current?.abort()
    }
  }, [])

  function invalidate() { setResult(null); setError('') }

  async function readFile(selected: File, date: string) {
    setBusy('import'); setError(''); setResult(null); setImported(null)
    setRecordProgress(null)
    try {
      const data = await importRegistration(selected, date)
      setImported(data)
      setCompetitors(data.competitors)
      setEvents(data.events.map((event) => ({
        event_id: event.event_id, event_name: event.event_name,
        num_groups: event.num_groups, num_scramblers_per_group: event.num_scramblers_per_group,
        use_runners: event.use_runners, num_runners_per_group: event.num_runners_per_group,
      })))
      setCompetitionName(data.competition_name)
      setRecordEvent(data.events[0]?.event_id ?? '')
      setParticipantSearch(''); setResultEvent(''); setResultSearch('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'CSVの読み込みに失敗しました。')
    } finally { setBusy(null) }
  }

  async function importFile(event: FormEvent) {
    event.preventDefault()
    if (file && competitionDate) await readFile(file, competitionDate)
  }

  async function trySample() {
    setBusy('import'); setError('')
    try {
      const response = await fetch('/samples/registration.csv')
      if (!response.ok) throw new Error('サンプルを読み込めませんでした。')
      const sample = new File([await response.text()], 'SampleCompetition-registration.csv',
        { type: 'text/csv' })
      setFile(sample); setCompetitionDate('2026-10-01')
      if (fileInput.current) fileInput.current.value = ''
      await readFile(sample, '2026-10-01')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'サンプルを読み込めませんでした。')
      setBusy(null)
    }
  }

  function updatePerson(personId: string, changes: Partial<Competitor>) {
    invalidate()
    setCompetitors((current) => current.map((person) => person.competitor_id === personId
      ? { ...person, ...changes } : person))
  }

  function updateRecord(person: Competitor, key: keyof PersonalRecord, value: number | null) {
    updatePerson(person.competitor_id, {
      events: { ...person.events, [recordEvent]: { ...person.events[recordEvent], [key]: value } },
    })
  }

  function updateEvent(eventId: string, changes: Partial<EventConfig>) {
    invalidate()
    setEvents((current) => current.map((event) => event.event_id === eventId
      ? { ...event, ...changes } : event))
  }

  async function runSolver(event: FormEvent) {
    if (busy !== null) { event.preventDefault(); return }
    event.preventDefault(); setBusy('solve'); setError(''); setResult(null)
    const controller = new AbortController()
    solverControl.current = controller
    try {
      const response = await solveAssignments({
        competition_name: competitionName, competition_date: competitionDate,
        num_stations: numStations, events, competitors, options,
      }, controller.signal)
      setResult(response)
    } catch (cause) {
      if (!(cause instanceof Error && cause.name === 'AbortError')) {
        setError(cause instanceof Error ? cause.message : '役割分担の計算に失敗しました。')
      }
    } finally { solverControl.current = null; setBusy(null) }
  }

  async function getWcaRecords() {
    if (busy || recordsControl.current) return
    const peopleByWcaId = new Map<string, Competitor[]>()
    for (const person of competitors) {
      const id = normalizedWcaId(person)
      if (id) peopleByWcaId.set(id, [...(peopleByWcaId.get(id) ?? []), person])
    }
    if (peopleByWcaId.size === 0) return
    const control = { stop: false, controller: new AbortController() }
    recordsControl.current = control
    setBusy('records'); setRecordsStopping(false); invalidate()
    setRecordProgress({
      total: peopleByWcaId.size, completed: 0, cached: 0, updatedEvents: 0,
      missingAverages: 0, currentId: '', failures: [], stopped: false,
    })
    let consecutiveFailures = 0
    try {
      // The browser client serializes same-origin tabs and enforces request spacing.
      for (const [id, people] of peopleByWcaId) {
        if (control.stop || control.controller.signal.aborted) break
        setRecordProgress((progress) => progress && { ...progress, currentId: id })
        try {
          const data = await fetchWcaRecords(id, control.controller.signal)
          const updates = new Map<string, Competitor>()
          let updatedEvents = 0
          let missingAverages = 0
          for (const person of people) {
            const merged = mergeWcaRecords(person, data.records, overwriteRecords)
            updates.set(person.competitor_id, merged.person)
            updatedEvents += merged.updatedEvents
            missingAverages += Object.entries(person.events).filter(([eventId]) =>
              eventId !== '333mbf' && data.records[eventId]?.average_time == null).length
          }
          setCompetitors((current) => current.map((person) => updates.get(person.competitor_id) ?? person))
          setRecordProgress((progress) => progress && {
            ...progress, completed: progress.completed + 1,
            cached: progress.cached + Number(data.cached),
            updatedEvents: progress.updatedEvents + updatedEvents,
            missingAverages: progress.missingAverages + missingAverages,
          })
          consecutiveFailures = 0
        } catch (cause) {
          if (control.controller.signal.aborted) break
          const message = cause instanceof Error ? cause.message : '取得できませんでした。'
          setRecordProgress((progress) => progress && {
            ...progress, completed: progress.completed + 1,
            failures: [...progress.failures, `${id}（${people.map((person) => person.name).join('・')}）: ${message}`],
          })
          consecutiveFailures = cause instanceof ApiError && cause.status < 500
            ? 0 : consecutiveFailures + 1
          if ((cause instanceof ApiError && [409, 429, 503].includes(cause.status)) || consecutiveFailures >= 3) {
            control.stop = true
            break
          }
        }
      }
    } finally {
      recordsControl.current = null
      if (!control.controller.signal.aborted) {
        setRecordProgress((progress) => progress && { ...progress, currentId: '', stopped: control.stop })
        setBusy(null); setRecordsStopping(false)
      }
    }
  }

  const validWcaIds = new Set(competitors.map(normalizedWcaId).filter((id) => id !== null))
  const skippedRecords = competitors.filter((person) => !normalizedWcaId(person)).length

  const visiblePeople = competitors.filter((person) =>
    `${person.name} ${person.wca_id ?? ''} ${person.competitor_id}`.toLowerCase()
      .includes(participantSearch.toLowerCase()),
  )
  const groupRows = events.flatMap((event) =>
    Array.from({ length: event.num_groups }, (_, index) => ({
      event, group: index + 1,
      assignments: result?.assignments.filter((item) =>
        item.event_id === event.event_id && item.group === index + 1) ?? [],
    })),
  ).filter((row) => (!resultEvent || row.event.event_id === resultEvent)
    && (!resultSearch || row.assignments.some((item) =>
      `${item.name} ${item.wca_id ?? ''}`.toLowerCase().includes(resultSearch.toLowerCase()))))
  const roleCounts = competitors.map((person) => result?.assignments.filter((item) =>
    item.competitor_id === person.competitor_id && item.role !== 'COMPETITOR').length ?? 0)
  const solved = result?.status === 'OPTIMAL' || result?.status === 'FEASIBLE'
  const currentStep = solved ? 3 : imported ? 2 : 1

  return (
    <main id="main-content" className="page-wrap assignment-page">
      <div className="assignment-heading">
        <p className="page-eyebrow">大会運営ツール</p>
        <h1>大会の役割分担をつくる</h1>
        <p className="assignment-muted">WCAの参加者CSVを読み込み、グループ・スクランブラー・ジャッジ・ランナーを割り当てます。</p>
        <p className="assignment-hint">CSVの読み込み・チェック・役割分担の計算は、このブラウザ内で行います。</p>
      </div>

      <ol className="assignment-steps" aria-label="役割分担の作成手順">
        {['参加者の読み込み', '大会・参加者の設定', '結果の確認・保存'].map((label, index) => {
          const step = index + 1
          return <li key={label} className={step < currentStep ? 'is-complete' : ''}
            aria-current={step === currentStep ? 'step' : undefined}>
            <span className="step-number">{step < currentStep ? <Check size={16} aria-hidden="true" /> : step}</span>
            <span>{label}</span>
          </li>
        })}
      </ol>

      <Card className="assignment-panel" role="region" aria-labelledby="import-title">
        <h2 id="import-title"><span className="step-number">1</span>参加者を読み込む</h2>
        <form onSubmit={(event) => { void importFile(event) }}>
          <fieldset disabled={busy !== null || !browserReady}>
            <div className="assignment-form-grid">
              <label>登録CSV
                <Input ref={fileInput} className="assignment-input" type="file" accept=".csv,text/csv"
                  aria-label="登録CSV" onChange={(event) => {
                    setFile(event.target.files?.[0] ?? null); setImported(null); invalidate()
                  }} />
              </label>
              <label>大会日（年齢の計算基準）
                <Input className="assignment-input" type="date" required value={competitionDate}
                  onInput={(event) => {
                    setCompetitionDate(event.currentTarget.value); setImported(null); invalidate()
                  }} />
              </label>
            </div>
            <div className="assignment-actions">
              <Button type="submit" disabled={!file || !competitionDate}>
                {busy === 'import' ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <Upload aria-hidden="true" />}
                {busy === 'import' ? '読み込み中…' : 'CSVを読み込む'}
              </Button>
              <Button variant="outline" type="button"
                onClick={() => { void trySample() }}><FlaskConical aria-hidden="true" />サンプルで試す</Button>
              {file && <span className="assignment-muted">{file.name}</span>}
            </div>
          </fieldset>
        </form>
        <p className="assignment-hint">承認済みの登録のみを使用します。メールアドレス・IP・コメントなどは役割分担に取り込みません。</p>
      </Card>

      {error && <Notice danger><p className="whitespace-pre-wrap">{error}</p></Notice>}

      {imported && <>
        <div className="assignment-summary">
          <span><strong>{competitors.length}</strong>人の参加者</span>
          <span><strong>{events.length}</strong>競技</span>
          <span>{imported.excluded_count}件の登録を除外</span>
        </div>
        {imported.warnings.length > 0 && <Notice><ul>{imported.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></Notice>}

        <form onSubmit={(event) => { void runSolver(event) }}>
          <fieldset disabled={busy === 'import' || busy === 'solve'}>
            <Card className="assignment-panel" role="region" aria-labelledby="config-title">
              <h2 id="config-title"><span className="step-number">2</span>大会と参加者を設定する</h2>
              <fieldset disabled={busy === 'records'}>
              <div className="assignment-form-grid">
                <label>大会名
                  <Input className="assignment-input" required maxLength={200} value={competitionName}
                    onChange={(event) => { setCompetitionName(event.target.value); invalidate() }} />
                </label>
                <label>競技卓数
                  <Input className="assignment-input" type="number" min={1} max={100} required
                    value={numStations} onChange={(event) => {
                      setNumStations(Number(event.target.value)); invalidate()
                    }} />
                </label>
                <label>ジャッジを免除する年齢（n歳以下）
                  <Input className="assignment-input" type="number" min={0} max={120} required
                    value={options.judge_exempt_age} onChange={(event) => {
                      setOptions({ ...options, judge_exempt_age: Number(event.target.value) }); invalidate()
                    }} />
                </label>
              </div>

              <h3>競技ごとの人数</h3>
              <div className="assignment-table-wrap">
                <table className="assignment-table">
                  <thead><tr><th>競技</th><th>参加者</th><th>グループ数</th><th>スクランブラー / G</th><th>ランナー</th><th>ランナー / G</th></tr></thead>
                  <tbody>{events.map((event) => {
                    const count = competitors.filter((person) => event.event_id in person.events).length
                    return <tr key={event.event_id}>
                      <th scope="row">{event.event_name}</th><td>{count}人</td>
                      <td><NumberInput label={`${event.event_name} グループ数`} value={event.num_groups}
                        min={1} max={count} onChange={(value) => updateEvent(event.event_id, { num_groups: value ?? 1 })} /></td>
                      <td><NumberInput label={`${event.event_name} スクランブラー人数`} value={event.num_scramblers_per_group}
                        onChange={(value) => updateEvent(event.event_id, { num_scramblers_per_group: value ?? 0 })} /></td>
                      <td><input type="checkbox" aria-label={`${event.event_name} ランナーを使う`} checked={event.use_runners}
                        onChange={(change) => updateEvent(event.event_id, {
                          use_runners: change.target.checked,
                          num_runners_per_group: change.target.checked ? 1 : 0,
                        })} /></td>
                      <td>{event.use_runners ? <NumberInput label={`${event.event_name} ランナー人数`}
                        value={event.num_runners_per_group} min={1}
                        onChange={(value) => updateEvent(event.event_id, { num_runners_per_group: value ?? 1 })} /> : '—'}</td>
                    </tr>
                  })}</tbody>
                </table>
              </div>
              <p className="assignment-hint">ジャッジは各グループの競技者数と競技卓数の小さい方の人数を割り当てます。競技卓数を超えるグループには待機席が必要です。</p>

              <div className="assignment-section-heading">
                <h3>参加者の役割条件</h3>
                <Input className="assignment-input search-input" aria-label="参加者検索"
                  placeholder="名前・WCA IDで検索" value={participantSearch}
                  onChange={(event) => setParticipantSearch(event.target.value)} />
              </div>
              <p className="assignment-hint">ジャッジは{options.judge_exempt_age + 1}歳以上・初参加でない人が対象です。「運営専任」は競技のみを割り当て、すべてのスタッフ役割から免除します。</p>
              <div className="assignment-table-wrap participant-table">
                <table className="assignment-table">
                  <thead><tr><th>名前 / WCA ID</th><th>年齢</th><th>初参加</th><th>ジャッジ免除</th><th>スクランブラー免除</th><th>運営専任</th></tr></thead>
                  <tbody>{visiblePeople.map((person) => <tr key={person.competitor_id}>
                    <th scope="row">{person.name}<small>{person.wca_id ?? 'WCA IDなし'}</small></th>
                    <td><NumberInput label={`${person.name} 年齢`} value={person.age} max={120}
                      onChange={(value) => updatePerson(person.competitor_id, { age: value ?? 0 })} /></td>
                    {(['is_newcomer', 'is_judge_exempt', 'is_scrambler_exempt', 'is_staff'] as const).map((key, index) =>
                      <td key={key}><input type="checkbox" aria-label={`${person.name} ${['初参加', 'ジャッジ免除', 'スクランブラー免除', '運営専任'][index]}`}
                        checked={person[key]} onChange={(event) => updatePerson(person.competitor_id, { [key]: event.target.checked })} /></td>,
                    )}
                  </tr>)}</tbody>
                </table>
              </div>
              </fieldset>

              <div className="wca-record-controls" aria-label="WCA記録の取得">
                <div className="assignment-actions">
                  <Button variant="outline" type="button"
                    disabled={busy !== null || validWcaIds.size === 0}
                    onClick={() => { void getWcaRecords() }}>
                    {busy === 'records' ? 'WCA記録を取得中…' : 'WCAから自己ベスト・平均記録を取得'}
                  </Button>
                  {busy === 'records' && <Button variant="outline" type="button"
                    disabled={recordsStopping} onClick={() => {
                      if (recordsControl.current) recordsControl.current.stop = true
                      setRecordsStopping(true)
                    }}>{recordsStopping ? '停止待ち…' : '取得を停止する'}</Button>}
                  <label className="wca-record-overwrite">
                    <input type="checkbox" checked={overwriteRecords} disabled={busy !== null}
                      onChange={(event) => setOverwriteRecords(event.target.checked)} />
                    入力済み記録を上書きする
                  </label>
                </div>
                <p className="assignment-hint">全参加者の参加競技を取得します（対象WCA ID {validWcaIds.size}件）。1人ずつ最低1秒間隔で取得し、6時間キャッシュします。WCA IDなし・形式不正の{skippedRecords}人は対象外です。</p>
                {recordProgress && <div className="wca-record-progress" role="status" aria-live="polite">
                  <p>{busy === 'records' ? '取得中' : recordProgress.stopped ? '取得を停止しました' : '取得完了'}：
                    {recordProgress.completed} / {recordProgress.total}件
                    {recordProgress.currentId && `（${recordProgress.currentId}）`}
                    {` / ${recordProgress.updatedEvents}件の参加競技を補完 / キャッシュ利用 ${recordProgress.cached}件`}
                  </p>
                  {busy === 'records' && <progress value={recordProgress.completed} max={recordProgress.total}
                    aria-label="WCA記録の取得進捗" />}
                  {recordsStopping && <p>現在の1人分が完了してから停止します。取得済みの記録は残ります。</p>}
                  {recordProgress.missingAverages > 0 && <p>公式平均がない参加競技：{recordProgress.missingAverages}件（単発記録から平均を推定しません）。</p>}
                  {recordProgress.failures.length > 0 && <details className="assignment-details" open>
                    <summary>取得できなかったWCA ID（{recordProgress.failures.length}件）</summary>
                    <ul className="assignment-warning-list">{recordProgress.failures.slice(0, 20).map((message) => <li key={message}>{message}</li>)}</ul>
                    {recordProgress.failures.length > 20 && <p>ほか{recordProgress.failures.length - 20}件</p>}
                    <p>取得済みの記録は保持します。時間を空けて再実行するとキャッシュを利用して続きから補完できます。</p>
                  </details>}
                </div>}
              </div>

              <fieldset disabled={busy === 'records'}>
              <details className="assignment-details">
                <summary>自己ベスト・平均記録を補完する</summary>
                <p className="assignment-hint">平均記録は速さ順のグループ分けとスクランブラーの優先度に使います。未入力でも計算できます。単位は秒（最少手数競技は手数）。ベスト記録は補助情報です。</p>
                <p className="assignment-hint">上のボタンからWCAの公式自己ベスト・平均を補完できます。公式平均がない競技は空欄のままです。複数目隠しのスコアはこの入力形式では扱えないため自動取得しません。</p>
                <label className="inline-label">記録を編集する競技
                  <select className="assignment-input" value={recordEvent} onChange={(event) => setRecordEvent(event.target.value)}>
                    {events.map((event) => <option key={event.event_id} value={event.event_id}>{event.event_name}</option>)}
                  </select>
                </label>
                <div className="assignment-table-wrap record-table">
                  <table className="assignment-table">
                    <thead><tr><th>参加者</th><th>ベスト記録</th><th>平均記録</th></tr></thead>
                    <tbody>{visiblePeople.filter((person) => recordEvent in person.events).map((person) => <tr key={person.competitor_id}>
                      <th scope="row">{person.name}</th>
                      {(['best_time', 'average_time'] as const).map((key) => <td key={key}>
                        <NumberInput label={`${person.name} ${key === 'best_time' ? 'ベスト記録' : '平均記録'}`}
                          value={person.events[recordEvent][key]} min={0.01} max={86400} step={0.01}
                          onChange={(value) => updateRecord(person, key, value)} />
                      </td>)}
                    </tr>)}</tbody>
                  </table>
                </div>
              </details>

              <details className="assignment-details">
                <summary>計算の詳細設定</summary>
                <div className="assignment-form-grid advanced-grid">
                  {([
                    ['time_limit_seconds', '制限時間（秒）', 1, 120],
                    ['scrambler_speed_weight', '速度優先の重み', 0, 1000],
                    ['balance_weight', '負荷均等化の重み', 0, 1000],
                  ] as const).map(([key, label, min, max]) => <label key={key}>{label}
                    <NumberInput label={label} value={options[key]} min={min} max={max}
                      onChange={(value) => { setOptions({ ...options, [key]: value ?? min }); invalidate() }} />
                  </label>)}
                </div>
              </details>
              <div className="assignment-actions">
                <Button type="submit">
                  {busy === 'solve' ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <Play aria-hidden="true" />}
                  {busy === 'solve' ? 'ブラウザ内で計算中…' : '役割分担を計算する'}
                </Button>
              </div>
              <p className="assignment-hint">自分の競技グループとその直前には役割を付けず、同じグループの複数役割を兼任させません。</p>
              </fieldset>
            </Card>
          </fieldset>
        </form>

        {busy === 'solve' && <div className="assignment-actions" role="status">
          <p className="assignment-hint">計算中です。初回は計算エンジンの読み込みにも時間がかかります。</p>
          <Button variant="outline" type="button"
            onClick={() => solverControl.current?.abort()}>計算を中止する</Button>
        </div>}

        {result && <Card className="assignment-panel" role="region" aria-labelledby="result-title">
          <div className="assignment-section-heading">
            <h2 id="result-title"><span className="step-number">3</span>割り当て結果</h2>
            <span className={`result-status ${solved ? 'success' : ''}`}>
              {{ OPTIMAL: '最適解', FEASIBLE: '実行可能な解', INFEASIBLE: '割り当て不可', UNKNOWN: '時間内に解なし', MODEL_INVALID: '検証エラー' }[result.status]}
            </span>
          </div>
          <p className="assignment-muted">計算時間 {result.solve_time_seconds.toFixed(2)}秒
            {solved && ` / 役割負荷 ${Math.min(...roleCounts)}〜${Math.max(...roleCounts)}回 / 制約検証済み`}</p>
          {result.diagnostics.length > 0 && <Notice danger><ul>{result.diagnostics.map((message) => <li key={message}>{message}</li>)}</ul></Notice>}
          {result.validation_errors.length > 0 && <Notice danger><ul>{result.validation_errors.map((message) => <li key={message}>{message}</li>)}</ul></Notice>}
          {result.warnings.length > 0 && <details className="assignment-details"><summary>確認事項（{result.warnings.length}件）</summary>
            <ul className="assignment-warning-list">{result.warnings.map((message) => <li key={message}>{message}</li>)}</ul>
          </details>}
          {solved && <>
            <div className="assignment-actions result-filters">
              <select className="assignment-input" aria-label="結果の競技" value={resultEvent} onChange={(event) => setResultEvent(event.target.value)}>
                <option value="">すべての競技</option>
                {events.map((event) => <option key={event.event_id} value={event.event_id}>{event.event_name}</option>)}
              </select>
              <Input className="assignment-input search-input" aria-label="結果の参加者検索" placeholder="参加者のいるグループを検索"
                value={resultSearch} onChange={(event) => setResultSearch(event.target.value)} />
              <Button variant="outline" type="button"
                onClick={() => downloadCsv(result.csv_content, `${competitionName}-assignments.csv`)}><Download aria-hidden="true" />結果CSVをダウンロード</Button>
            </div>
            <p className="assignment-hint">結果CSVは1人1行、Name列と競技IDの列で出力します。例：2;J3;S4（グループ2で競技、グループ3でジャッジ、グループ4でスクランブラー）。</p>
            <div className="assignment-table-wrap result-table">
              <table className="assignment-table">
                <thead><tr><th>競技 / グループ</th>{Object.values(roleLabels).map((label) => <th key={label}>{label}</th>)}</tr></thead>
                <tbody>{groupRows.map(({ event, group, assignments }) => <tr key={`${event.event_id}-${group}`}>
                  <th scope="row">{event.event_name}<small>グループ {group}</small></th>
                  {(Object.keys(roleLabels) as Role[]).map((role) => {
                    const people = assignments.filter((item) => item.role === role)
                    return <td key={role}>{people.length > 0 ? <>
                      <span className="assignment-hint">{people.length}人</span>
                      <ul className="assignment-name-list">{people.map((person) => <li key={person.competitor_id}>{person.name}</li>)}</ul>
                    </> : <span className="assignment-muted">—</span>}</td>
                  })}
                </tr>)}</tbody>
              </table>
            </div>
          </>}
        </Card>}
      </>}
      <ParticipationCheck competitionDate={competitionDate} ageLimit={options.judge_exempt_age}
        numStations={numStations} disabled={busy !== null}
        onDateChange={(value) => { setCompetitionDate(value); setImported(null); invalidate() }}
        onAgeLimitChange={(value) => { setOptions({ ...options, judge_exempt_age: value }); invalidate() }}
        onStationsChange={(value) => { setNumStations(value); invalidate() }} />
    </main>
  )
}
