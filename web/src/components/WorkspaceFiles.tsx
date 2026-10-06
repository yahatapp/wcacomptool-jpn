import { Download, FileText, History, Upload } from 'lucide-react'
import { useRef, useState } from 'react'
import { Button } from './ui/button'
import { Card } from './ui/card'
import { Input } from './ui/input'
import type { WorkspaceSession } from './useWorkspace'
import type { WorkspaceResult } from '../lib/workspace-storage'
import { downloadFile } from '../lib/assignments'

export default function WorkspaceFiles({ session, disabled, onRegistration, onHistory, onBusyChange }: {
  session: WorkspaceSession
  disabled: boolean
  onRegistration: (id: string) => Promise<void>
  onHistory: (history: WorkspaceResult) => Promise<void>
  onBusyChange: (busy: boolean) => void
}) {
  const record = session.loaded!.record
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const upload = useRef<HTMLInputElement>(null)
  const inputs = record.files.filter((file) => file.source === 'imported')

  async function perform(action: () => Promise<void>) {
    setBusy(true); onBusyChange(true); setError('')
    try { await action() }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'CSVを開けませんでした。') }
    finally { setBusy(false); onBusyChange(false) }
  }

  return <Card className="assignment-panel" role="region" aria-labelledby="saved-files-title">
    <h2 id="saved-files-title"><FileText aria-hidden="true" />保存したCSV・結果履歴</h2>
    <fieldset disabled={disabled || busy}>
      <label className="workspace-upload">大会で使うCSVを追加
        <Input ref={upload} className="assignment-input" type="file" accept=".csv,text/csv" multiple
          disabled={!!session.error}
          aria-label="大会で使うCSVを追加" onChange={(event) => {
            const files = Array.from(event.target.files ?? [])
            void perform(async () => {
              for (const file of files) await session.addCsv(record.id, file)
              if (upload.current) upload.current.value = ''
            })
          }} />
      </label>
      {inputs.length > 0 ? <ul className="workspace-file-list">
        {inputs.map((file) => <li key={file.id}>
          <div><strong>{file.name}</strong><small>{(file.size / 1024).toFixed(1)} KB · {new Date(file.createdAt).toLocaleString('ja-JP')}</small></div>
          <div className="workspace-file-actions">
            <Button type="button" variant="outline" size="sm" disabled={!!session.error} onClick={() => { void perform(() => onRegistration(file.id)) }}>
              <Upload aria-hidden="true" />登録CSVに使う
            </Button>
            <Button type="button" variant="ghost" size="sm" aria-label={`${file.name}をダウンロード`}
              onClick={() => { void perform(async () => downloadFile(await session.readFile(record.id, file.id))) }}>
              <Download aria-hidden="true" />ダウンロード
            </Button>
          </div>
        </li>)}
      </ul> : <p className="assignment-hint">CSVを読み込むと、この大会に保存されます。照合用のCSVもここへ追加できます。</p>}

      <h3><History size={18} aria-hidden="true" />結果CSVの履歴（{record.history.length}件）</h3>
      {record.history.length > 0 ? <ul className="workspace-file-list">
        {[...record.history].reverse().map((item) => {
          const file = record.files.find((entry) => entry.id === item.fileId)!
          return <li key={item.id}>
            <div><strong>{file.name}</strong><small>{new Date(item.createdAt).toLocaleString('ja-JP')} · {item.state.competitors.length}人 · {item.state.num_stations}卓</small></div>
            <div className="workspace-file-actions">
              <Button type="button" variant="outline" size="sm" disabled={!!session.error} onClick={() => { void perform(() => onHistory(item)) }}>この結果と設定を開く</Button>
              <Button type="button" variant="ghost" size="sm" aria-label={`${file.name}をダウンロード`}
                onClick={() => { void perform(async () => downloadFile(await session.readFile(record.id, file.id))) }}>
                <Download aria-hidden="true" />ダウンロード
              </Button>
            </div>
          </li>
        })}
      </ul> : <p className="assignment-hint">計算に成功した結果CSVを、計算時の設定と一緒に自動で残します。</p>}
    </fieldset>
    {error && <div className="assignment-notice assignment-notice-danger" role="alert"><p>{error}</p></div>}
  </Card>
}
