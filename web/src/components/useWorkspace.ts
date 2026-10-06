import { useCallback, useEffect, useRef, useState } from 'react'
import type { SolveResponse } from '../lib/assignments'
import { readCsvFile, readCsvRows } from '../lib/registration'
import {
  emptyWorkspace, storageError, WorkspaceConflictError, WorkspaceStorage,
} from '../lib/workspace-storage'
import type {
  CompetitionWorkspace, LoadedWorkspace, WorkspaceCsv, WorkspaceResult, WorkspaceState,
} from '../lib/workspace-storage'

export function useWorkspace() {
  const [loaded, setLoaded] = useState<LoadedWorkspace | null>(null)
  const [workspaces, setWorkspaces] = useState<CompetitionWorkspace[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [conflict, setConflict] = useState(false)
  const [persistent, setPersistent] = useState<boolean | null>(null)
  const storage = useRef<WorkspaceStorage | null>(null)
  const current = useRef<CompetitionWorkspace | null>(null)
  const pendingState = useRef<{ id: string; state: WorkspaceState } | null>(null)
  const failure = useRef<unknown>(null)
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const pending = useRef(0)
  const mounted = useRef(false)
  const initialization = useRef(0)
  const persistenceRequested = useRef(false)

  const report = useCallback((cause: unknown) => {
    failure.current = cause
    if (mounted.current) {
      setError(storageError(cause))
      setConflict(cause instanceof WorkspaceConflictError)
    }
  }, [])

  const enqueue = useCallback(<T,>(action: () => Promise<T>): Promise<T> => {
    pending.current++
    if (mounted.current) setSaving(true)
    const task = queue.current.then(action)
    queue.current = task.catch(() => undefined)
    return task.finally(() => {
      pending.current--
      if (mounted.current) setSaving(pending.current > 0)
    })
  }, [])

  const publish = useCallback((record: CompetitionWorkspace) => {
    current.current = record
    if (mounted.current) {
      setWorkspaces((records) => [record, ...records.filter((item) => item.id !== record.id)])
      setLoaded((value) => value?.record.id === record.id ? { ...value, record } : value)
    }
  }, [])

  const commit = useCallback(async (record: CompetitionWorkspace) => {
    if (!storage.current) throw new Error('大会の保存領域を開けませんでした。保存を再試行してください。')
    if (failure.current) throw failure.current
    const saved = await storage.current.save(record, record.revision)
    publish(saved)
    return saved
  }, [publish])

  const initialize = useCallback(async () => {
    const generation = ++initialization.current
    setLoading(true)
    try {
      storage.current?.close()
      const repository = await WorkspaceStorage.open()
      if (!mounted.current || generation !== initialization.current) { repository.close(); return }
      storage.current = repository
      const records = await repository.list()
      const last = await repository.lastWorkspaceId()
      let record = records.find((item) => item.id === last) ?? records[0]
      if (!record) record = await repository.save(emptyWorkspace(), null)
      const opened = await repository.load(record)
      await repository.select(record.id)
      current.current = record
      failure.current = null
      if (mounted.current && generation === initialization.current) {
        setWorkspaces([record, ...records.filter((item) => item.id !== record.id)])
        setLoaded(opened); setError(''); setConflict(false)
        setPersistent(await navigator.storage.persisted())
      }
    } catch (cause) { if (generation === initialization.current) report(cause) }
    finally { if (mounted.current && generation === initialization.current) setLoading(false) }
  }, [report])

  useEffect(() => {
    mounted.current = true
    void initialize()
    return () => {
      mounted.current = false; initialization.current++
      const repository = storage.current
      void queue.current.finally(() => repository?.close())
    }
  }, [initialize])

  const saveState = useCallback((id: string, state: WorkspaceState) => {
    pendingState.current = { id, state }
    return enqueue(async () => {
      if (current.current?.id !== id) return
      if (JSON.stringify(current.current.state) === JSON.stringify(state)) return
      try { await commit({ ...current.current, state }) }
      catch (cause) { report(cause) }
    })
  }, [commit, enqueue, report])

  const requestPersistence = useCallback(() => {
    if (persistenceRequested.current) return
    persistenceRequested.current = true
    void navigator.storage.persist().then((granted) => {
      if (mounted.current) setPersistent(granted)
    }).catch(() => { if (mounted.current) setPersistent(false) })
  }, [])

  const addCsv = useCallback(async (id: string, file: File) => {
    // Invalid input is a CSV error, not a storage outage. Keep autosave available.
    readCsvRows(await readCsvFile(file))
    return enqueue(async () => {
      if (current.current?.id !== id || !storage.current) throw new Error('大会を開き直してください。')
      if (failure.current) throw failure.current
      let entry: WorkspaceCsv | undefined
      try {
        entry = await storage.current.writeCsv(id, file, 'imported')
        await commit({ ...current.current, files: [...current.current.files, entry] })
        requestPersistence()
        return entry
      } catch (cause) {
        if (entry) await storage.current.removeCsv(id, entry).catch(() => undefined)
        report(cause); throw cause
      }
    })
  }, [commit, enqueue, report, requestPersistence])

  const saveResult = useCallback((id: string, response: SolveResponse, state: WorkspaceState) => enqueue(async () => {
    if (current.current?.id !== id || !storage.current) throw new Error('大会を開き直してください。')
    if (failure.current) throw failure.current
    let entry: WorkspaceCsv | undefined
    try {
      const createdAt = new Date().toISOString()
      const filename = `${state.competition_name || 'competition'}-assignments-${createdAt.replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}.csv`
      const file = new File(['\uFEFF', response.csv_content], filename, { type: 'text/csv;charset=utf-8' })
      entry = await storage.current.writeCsv(id, file, 'generated')
      const { csv_content: _csv, ...result } = response
      const item: WorkspaceResult = { id: crypto.randomUUID(), fileId: entry.id, createdAt, state, result }
      await commit({
        ...current.current, files: [...current.current.files, entry], history: [...current.current.history, item],
        state: { ...state, result, resultFileId: entry.id, checker: { ...state.checker, resultFileId: entry.id } },
      })
      requestPersistence()
      return item
    } catch (cause) {
      if (entry) await storage.current.removeCsv(id, entry).catch(() => undefined)
      report(cause); throw cause
    }
  }), [commit, enqueue, report, requestPersistence])

  const readFile = useCallback(async (id: string, fileId: string) => {
    const entry = current.current?.id === id ? current.current.files.find((file) => file.id === fileId) : undefined
    if (!entry || !storage.current) throw new Error('保存済みCSVが見つかりません。')
    return storage.current.readCsv(id, entry)
  }, [])

  const openWorkspace = useCallback((id: string | null) => {
    setLoading(true)
    return enqueue(async () => {
      if (!storage.current) throw new Error('大会の保存領域を開けませんでした。')
      // Do not discard failed saves when navigating between competitions.
      if (failure.current) throw failure.current
      const records = await storage.current.list()
      const record = id ? records.find((item) => item.id === id) : await storage.current.save(emptyWorkspace(), null)
      if (!record) throw new Error('この大会は削除されています。ページを再読み込みしてください。')
      const opened = await storage.current.load(record)
      await storage.current.select(record.id)
      current.current = record; pendingState.current = null
      setWorkspaces([record, ...records.filter((item) => item.id !== record.id)])
      setLoaded(opened)
    }).catch(report).finally(() => { if (mounted.current) setLoading(false) })
  }, [enqueue, report])

  const deleteWorkspace = useCallback(() => {
    setLoading(true)
    return enqueue(async () => {
      if (!storage.current || !current.current) return
      if (failure.current instanceof WorkspaceConflictError) throw failure.current
      await storage.current.remove(current.current)
      const records = await storage.current.list()
      const record = records[0] ?? await storage.current.save(emptyWorkspace(), null)
      const opened = await storage.current.load(record)
      await storage.current.select(record.id)
      current.current = record; pendingState.current = null
      failure.current = null; setError(''); setConflict(false)
      setWorkspaces([record, ...records.filter((item) => item.id !== record.id)])
      setLoaded(opened)
    }).catch(report).finally(() => { if (mounted.current) setLoading(false) })
  }, [enqueue, report])

  const retry = useCallback(() => {
    if (!loaded || !storage.current) return initialize()
    return enqueue(async () => {
      failure.current = null
      try {
        const record = current.current!
        await commit(pendingState.current?.id === record.id ? { ...record, state: pendingState.current.state } : record)
        setError(''); setConflict(false)
      } catch (cause) { report(cause) }
    })
  }, [commit, enqueue, initialize, loaded, report])

  return {
    loaded, workspaces, loading, saving, error, conflict, persistent,
    saveState, addCsv, saveResult, readFile, openWorkspace, deleteWorkspace, retry,
  }
}

export type WorkspaceSession = ReturnType<typeof useWorkspace>
