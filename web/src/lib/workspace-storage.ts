import type { CsvCheckSelection, ImportResponse, SolveRequest, SolveResponse } from './assignments.ts'
import { readCsvFile, readCsvRows } from './registration.ts'

export type StoredSolveResponse = Omit<SolveResponse, 'csv_content'>
export type WorkspaceState = SolveRequest & {
  overwriteRecords: boolean
  imported: ImportResponse | null
  registrationFileId: string | null
  result: StoredSolveResponse | null
  resultFileId: string | null
  checker: {
    registrationFileId: string | null
    resultFileId: string | null
    selection: CsvCheckSelection
  }
}
export type WorkspaceCsv = {
  id: string
  name: string
  size: number
  createdAt: string
  source: 'imported' | 'generated'
}
export type WorkspaceResult = {
  id: string
  fileId: string
  createdAt: string
  state: WorkspaceState
  result: StoredSolveResponse
}
export type CompetitionWorkspace = {
  version: 1
  id: string
  revision: number
  createdAt: string
  updatedAt: string
  state: WorkspaceState
  files: WorkspaceCsv[]
  history: WorkspaceResult[]
}
export type LoadedWorkspace = {
  record: CompetitionWorkspace
  files: Record<string, File>
}

export function emptyWorkspace(): CompetitionWorkspace {
  const now = new Date().toISOString()
  return {
    version: 1, id: crypto.randomUUID(), revision: 0, createdAt: now, updatedAt: now,
    files: [], history: [],
    state: {
      competition_name: '', competition_date: '', num_stations: 20,
      overwriteRecords: false,
      imported: null, events: [], competitors: [], registrationFileId: null,
      options: { time_limit_seconds: 30, scrambler_speed_weight: 100, balance_weight: 50, judge_exempt_age: 12 },
      result: null, resultFileId: null,
      checker: {
        registrationFileId: null, resultFileId: null,
        selection: { participation: true, newcomers: false, age: false, staffing: false },
      },
    },
  }
}

export class WorkspaceConflictError extends Error {
  constructor() {
    super('別のタブでこの大会が変更・削除されました。保存を停止しています。必要なCSVをダウンロードしてから、このページを再読み込みしてください。')
  }
}

export function storageError(cause: unknown): string {
  if (cause instanceof DOMException && cause.name === 'QuotaExceededError') {
    return 'ブラウザの保存容量が不足しています。不要な大会を削除してから、保存を再試行してください。'
  }
  return cause instanceof Error ? cause.message : 'ブラウザへの保存に失敗しました。'
}

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result)
    value.onerror = () => reject(value.error)
  })
}

function completed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error ?? new Error('保存処理が中断されました。'))
    transaction.onerror = () => { /* onabort reports the transaction failure. */ }
  })
}

export class WorkspaceStorage {
  private constructor(private db: IDBDatabase, private root: FileSystemDirectoryHandle) {}

  static async open(): Promise<WorkspaceStorage> {
    if (!globalThis.indexedDB || !navigator.storage?.getDirectory) {
      throw new Error('このブラウザでは大会を保存できません。HTTPSまたはlocalhostで、Chrome・Edgeの通常ウィンドウを使ってください。')
    }
    const root = await (await navigator.storage.getDirectory())
      .getDirectoryHandle('wca-competition-workspaces', { create: true })
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const opening = indexedDB.open('wca-competition-workspaces', 1)
      opening.onupgradeneeded = () => {
        opening.result.createObjectStore('workspaces', { keyPath: 'id' })
        opening.result.createObjectStore('preferences')
      }
      opening.onsuccess = () => {
        opening.result.onversionchange = () => opening.result.close()
        resolve(opening.result)
      }
      opening.onerror = () => reject(opening.error)
      opening.onblocked = () => reject(new Error('保存領域の更新が待機中です。このアプリのほかのタブを閉じて再試行してください。'))
    })
    return new WorkspaceStorage(db, root)
  }

  close() { this.db.close() }

  async list(): Promise<CompetitionWorkspace[]> {
    const records = await request(this.db.transaction('workspaces').objectStore('workspaces').getAll()) as CompetitionWorkspace[]
    if (records.some((record) => record.version !== 1)) throw new Error('この大会の保存形式には対応していません。アプリを更新してください。')
    return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  async lastWorkspaceId(): Promise<string | undefined> {
    return request(this.db.transaction('preferences').objectStore('preferences').get('lastWorkspaceId'))
  }

  async select(id: string): Promise<void> {
    const transaction = this.db.transaction('preferences', 'readwrite')
    const done = completed(transaction)
    transaction.objectStore('preferences').put(id, 'lastWorkspaceId')
    await done
  }

  async save(record: CompetitionWorkspace, expectedRevision: number | null): Promise<CompetitionWorkspace> {
    const transaction = this.db.transaction('workspaces', 'readwrite')
    const done = completed(transaction)
    const store = transaction.objectStore('workspaces')
    const next = { ...record, revision: (expectedRevision ?? 0) + 1, updatedAt: new Date().toISOString() }
    // Compare and write in the same transaction, so another tab cannot overwrite edits.
    let conflict = false
    const existing = store.get(record.id)
    existing.onsuccess = () => {
      const current = existing.result as CompetitionWorkspace | undefined
      if (expectedRevision === null ? !!current : current?.revision !== expectedRevision) {
        conflict = true
        transaction.abort()
      } else store.put(next)
    }
    try { await done } catch (cause) {
      if (conflict) throw new WorkspaceConflictError()
      throw cause
    }
    return next
  }

  private async directory(id: string, source: WorkspaceCsv['source'], create = false) {
    const workspace = await this.root.getDirectoryHandle(id, { create })
    return workspace.getDirectoryHandle(source === 'generated' ? 'outputs' : 'inputs', { create })
  }

  async writeCsv(workspaceId: string, file: File, source: WorkspaceCsv['source']): Promise<WorkspaceCsv> {
    if (source === 'imported') readCsvRows(await readCsvFile(file))
    const entry: WorkspaceCsv = {
      id: crypto.randomUUID(), name: file.name, size: file.size,
      source, createdAt: new Date().toISOString(),
    }
    const directory = await this.directory(workspaceId, source, true)
    const handle = await directory.getFileHandle(`${entry.id}.csv`, { create: true })
    try {
      const writable = await handle.createWritable()
      try { await writable.write(file); await writable.close() }
      catch (cause) { await writable.abort().catch(() => undefined); throw cause }
    } catch (cause) {
      await directory.removeEntry(`${entry.id}.csv`).catch(() => undefined)
      throw cause
    }
    return entry
  }

  async readCsv(workspaceId: string, entry: WorkspaceCsv): Promise<File> {
    const directory = await this.directory(workspaceId, entry.source)
    const file = await (await directory.getFileHandle(`${entry.id}.csv`)).getFile()
    return new File([file], entry.name, { type: 'text/csv', lastModified: Date.parse(entry.createdAt) })
  }

  async removeCsv(workspaceId: string, entry: WorkspaceCsv): Promise<void> {
    const directory = await this.directory(workspaceId, entry.source)
    await directory.removeEntry(`${entry.id}.csv`)
  }

  async load(record: CompetitionWorkspace): Promise<LoadedWorkspace> {
    const ids = new Set([
      record.state.registrationFileId, record.state.resultFileId,
      record.state.checker.registrationFileId, record.state.checker.resultFileId,
    ].filter((id): id is string => !!id))
    const files: Record<string, File> = {}
    for (const id of ids) {
      const entry = record.files.find((file) => file.id === id)
      if (!entry) throw new Error('保存済みCSVの情報が見つかりません。')
      files[id] = await this.readCsv(record.id, entry)
    }
    return { record, files }
  }

  async remove(record: CompetitionWorkspace): Promise<void> {
    const transaction = this.db.transaction(['workspaces', 'preferences'], 'readwrite')
    const done = completed(transaction)
    let conflict = false
    const store = transaction.objectStore('workspaces')
    const existing = store.get(record.id)
    existing.onsuccess = () => {
      if (existing.result?.revision !== record.revision) { conflict = true; transaction.abort(); return }
      store.delete(record.id)
      const preferences = transaction.objectStore('preferences')
      const last = preferences.get('lastWorkspaceId')
      last.onsuccess = () => { if (last.result === record.id) preferences.delete('lastWorkspaceId') }
    }
    try { await done } catch (cause) {
      if (conflict) throw new WorkspaceConflictError()
      throw cause
    }
    // Metadata is removed first. A crash during cleanup cannot leave a visible
    // workspace referring to deleted files. Never remove other apps' OPFS data.
    await this.root.removeEntry(record.id, { recursive: true }).catch((cause) => {
      if (!(cause instanceof DOMException && cause.name === 'NotFoundError')) throw cause
    })
  }
}
