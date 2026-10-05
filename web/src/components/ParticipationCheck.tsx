import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { FileCheck2, LoaderCircle } from 'lucide-react'
import { Button } from './ui/button'
import { Card } from './ui/card'
import { Input } from './ui/input'
import { Switch } from './ui/switch'
import { checkCsv, csvCheckLabels } from '../lib/assignments'
import type { CsvCheckKey, CsvCheckResponse, CsvCheckResult, CsvCheckSelection } from '../lib/assignments'

type CheckProps = {
  competitionDate: string
  ageLimit: number
  numStations: number
  disabled: boolean
  onDateChange: (value: string) => void
  onAgeLimitChange: (value: number) => void
  onStationsChange: (value: number) => void
}

function CheckResult({ check }: { check: CsvCheckResult }) {
  return <div className="csv-check-result">
    <h3>{csvCheckLabels[check.key]}</h3>
    <div className={`assignment-notice ${check.passed ? '' : 'assignment-notice-danger'}`} role="status">
      <p>{check.passed ? '問題は見つかりませんでした。' : `確認事項が${check.issues.length}件あります。`}
        {` / 対象：${check.checked_count}${check.key === 'staffing' ? 'グループ' : '人'}`}</p>
    </div>
    {check.key === 'staffing' ? <div className="assignment-table-wrap">
      <table className="assignment-table">
        <thead><tr><th>競技 / グループ</th><th>競技者</th><th>必要ジャッジ人数</th><th>ジャッジ（J）</th><th>スクランブラー（S）</th><th>ランナー（R）</th><th>判定</th></tr></thead>
        <tbody>{check.groups.map((group) => <tr key={`${group.event_id}-${group.group}`}>
          <th scope="row">{group.event_id} G{group.group}</th>
          <td>{group.competitor_count}人</td><td>{group.required_count}人</td><td>{group.judge_count}人</td>
          <td>{group.scrambler_count}人</td><td>{group.runner_count}人</td>
          <td>{group.passed ? 'OK' : `ジャッジが${group.required_count - group.judge_count}人不足`}</td>
        </tr>)}</tbody>
      </table>
    </div> : check.issues.length > 0 && <div className="assignment-table-wrap">
      {check.key === 'participation' ? <table className="assignment-table">
        <thead><tr><th>名前</th><th>確認事項</th><th>登録CSVの参加競技</th><th>結果CSVの参加競技</th><th>不足している競技</th><th>余分な競技</th></tr></thead>
        <tbody>{check.issues.map((issue, index) => <tr key={`${issue.name}-${index}`}>
          <th scope="row">{issue.name}</th><td>{issue.message}</td>
          {(['expected_events', 'actual_events', 'missing_events', 'extra_events'] as const).map((key) =>
            <td key={key}>{issue.kind === 'ambiguous_name' ? '照合不可' : issue[key].join(', ') || 'なし'}</td>,
          )}
        </tr>)}</tbody>
      </table> : <table className="assignment-table">
        <thead><tr><th>名前</th><th>年齢</th><th>割り当たっている役割</th><th>確認事項</th></tr></thead>
        <tbody>{check.issues.map((issue, index) => <tr key={`${issue.name}-${index}`}>
          <th scope="row">{issue.name}</th>
          <td>{issue.age === null ? '—' : `${issue.age}歳`}</td>
          <td>{issue.assignments.map((role) => `${role.event_id} ${role.role}${role.group}`).join(', ')}</td>
          <td>{issue.message}</td>
        </tr>)}</tbody>
      </table>}
    </div>}
  </div>
}

export default function ParticipationCheck({
  competitionDate, ageLimit, numStations, disabled, onDateChange, onAgeLimitChange, onStationsChange,
}: CheckProps) {
  const [registrationFile, setRegistrationFile] = useState<File | null>(null)
  const [resultFile, setResultFile] = useState<File | null>(null)
  const [selection, setSelection] = useState<CsvCheckSelection>({
    participation: true, newcomers: false, age: false, staffing: false,
  })
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState<CsvCheckResponse | null>(null)
  const [error, setError] = useState('')
  const requestVersion = useRef(0)
  const needsRegistration = selection.participation || selection.newcomers || selection.age
  const hasSelection = Object.values(selection).some(Boolean)

  function invalidate() { requestVersion.current += 1; setResult(null); setError('') }

  useEffect(() => {
    invalidate()
  }, [competitionDate, ageLimit, numStations])

  async function runCheck(event: FormEvent) {
    event.preventDefault()
    if (checking || disabled || !hasSelection || !resultFile || (needsRegistration && !registrationFile)) return
    setChecking(true); invalidate()
    const version = requestVersion.current
    try {
      const response = await checkCsv(needsRegistration ? registrationFile : null, resultFile, {
        ...selection, competition_date: selection.age ? competitionDate || null : null,
        age_limit: ageLimit, num_stations: numStations,
      })
      if (version === requestVersion.current) setResult(response)
    } catch (cause) {
      if (version === requestVersion.current) {
        setError(cause instanceof Error ? cause.message : 'CSVのチェックに失敗しました。')
      }
    } finally { setChecking(false) }
  }

  const hints: Record<CsvCheckKey, string> = {
    participation: '元の登録CSVの参加競技と、結果CSVの数字のみの項目を比較します。',
    newcomers: '登録CSVのWCA IDが空欄の人に、J・S・Rが割り当たっていないか確認します。',
    age: `${ageLimit}歳以下の人に、J・S・Rが割り当たっていないか確認します。年齢は生年月日と大会日から計算します。`,
    staffing: '各競技・各グループのジャッジ（J）人数が、競技者数と競技卓数の小さい方以上か確認します。',
  }

  return <Card className="assignment-panel" role="region" aria-labelledby="check-title">
    <h2 id="check-title"><FileCheck2 size={22} aria-hidden="true" />CSVの割り当てをチェック</h2>
    <p className="assignment-hint">チェックしたい項目をオンにして、CSVを選んでください。割り当ての計算なしでも使えます。</p>
    <form onSubmit={(event) => { void runCheck(event) }}>
      <fieldset disabled={checking || disabled}>
        <div className="csv-check-options" aria-label="チェック項目">
          {(Object.keys(csvCheckLabels) as CsvCheckKey[]).map((key) => <label className="csv-check-option" key={key} htmlFor={`csv-check-${key}`}>
            <Switch id={`csv-check-${key}`} disabled={checking || disabled}
              aria-label={csvCheckLabels[key]} checked={selection[key]}
              onCheckedChange={(checked) => { setSelection({ ...selection, [key]: checked }); invalidate() }} />
            <span><strong>{csvCheckLabels[key]}</strong><small>{hints[key]}</small></span>
          </label>)}
        </div>
        {(selection.age || selection.staffing) && <>
          <div className="assignment-form-grid csv-check-settings">
            {selection.age && <>
              <label>大会日（年齢チェック・グループ分けで共通）
                <Input className="assignment-input" type="date" required value={competitionDate}
                  onChange={(event) => onDateChange(event.target.value)} />
              </label>
              <label>役割を確認する年齢（n歳以下・グループ分けで共通）
                <Input className="assignment-input" type="number" min={0} max={120} required
                  value={ageLimit} onChange={(event) => onAgeLimitChange(Number(event.target.value))} />
              </label>
            </>}
            {selection.staffing && <label>競技卓数（グループ分けで共通）
              <Input className="assignment-input" type="number" min={1} max={100} required
                value={numStations} onChange={(event) => onStationsChange(Number(event.target.value))} />
            </label>}
          </div>
          {selection.age && <p className="assignment-hint">グループ分けでは、この年齢以下の人をジャッジから免除します。年齢チェックではJ・S・Rすべてを確認します。</p>}
        </>}
        <div className="assignment-form-grid csv-check-files">
          <label>照合用の登録CSV（元CSV）{!needsRegistration && '・卓数チェックだけなら不要'}
            <Input className="assignment-input" type="file" accept=".csv,text/csv"
              required={needsRegistration} onChange={(event) => {
                setRegistrationFile(event.target.files?.[0] ?? null); invalidate()
              }} />
          </label>
          <label>照合用の結果CSV
            <Input className="assignment-input" type="file" accept=".csv,text/csv"
              required onChange={(event) => {
                setResultFile(event.target.files?.[0] ?? null); invalidate()
              }} />
          </label>
        </div>
        <div className="assignment-actions">
          <Button type="submit"
            disabled={!hasSelection || !resultFile || (needsRegistration && !registrationFile)}>
            {checking ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <FileCheck2 aria-hidden="true" />}
            {checking ? 'チェック中…' : '選択した項目をチェック'}
          </Button>
        </div>
        {!hasSelection && <p className="assignment-hint">チェック項目を1つ以上選択してください。</p>}
      </fieldset>
    </form>
    <p className="assignment-hint">結果CSVはName列と競技IDの列を使います。数字のみは競技グループ、Jはジャッジ、Sはスクランブラー、Rはランナーです。</p>
    <p className="assignment-hint">登録CSVの名前は「(」より前の英語名で照合します。名前の前後・連続する空白をそろえ、同名の行は照合できないため表示します。CSVは保存しません。</p>
    {error && <div className="assignment-notice assignment-notice-danger" role="alert">
      <p className="whitespace-pre-wrap">{error}</p>
    </div>}
    {result && <div aria-live="polite">
      <p>{result.passed ? '選択したすべてのチェックを通過しました。' : '確認が必要な項目があります。'}</p>
      {result.checks.map((check) => <CheckResult key={check.key} check={check} />)}
    </div>}
  </Card>
}
