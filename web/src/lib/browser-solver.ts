import type { SolveRequest, SolveResponse } from './assignments.ts'
import type { SolverMessage } from './solver.worker.ts'
import { validateSolveRequest } from './competition.ts'

let running = false

export function solveInBrowser(request: SolveRequest, signal?: AbortSignal): Promise<SolveResponse> {
  validateSolveRequest(request)
  if (signal?.aborted) return Promise.reject(new DOMException('計算を中止しました。', 'AbortError'))
  if (!globalThis.crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') {
    throw new Error('このページでは計算を開始できません。HTTPS または localhost で開き、配信設定の COOP・COEP ヘッダーを確認してください。')
  }
  if (running) throw new Error('別の計算が実行中です。完了後に再実行してください。')
  const worker = new Worker(new URL('./solver.worker.ts', import.meta.url), { type: 'module', name: 'assignment-solver' })
  running = true
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>
    let settled = false
    const finish = (result?: SolveResponse, error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer); signal?.removeEventListener('abort', abort)
      worker.terminate(); running = false
      if (error) reject(error)
      else resolve(result!)
    }
    const abort = () => finish(undefined, new DOMException('計算を中止しました。', 'AbortError'))
    signal?.addEventListener('abort', abort, { once: true })
    worker.onmessage = (event: MessageEvent<SolverMessage>) => {
      if (event.data.type === 'result') finish(event.data.result)
      else finish(undefined, new Error(event.data.message))
    }
    worker.onerror = (event) => { event.preventDefault(); finish(undefined, new Error(`計算エンジンを実行できませんでした。${event.message}`)) }
    worker.onmessageerror = () => finish(undefined, new Error('計算結果を読み取れませんでした。'))
    // Loading and model construction are outside CP-SAT's search time limit.
    timer = setTimeout(() => finish(undefined, new Error('計算エンジンが応答しませんでした。ページを再読み込みして再実行してください。')),
      request.options.time_limit_seconds * 1000 + 120_000)
    try { worker.postMessage(request) }
    catch (error) { finish(undefined, error instanceof Error ? error : new Error('計算を開始できませんでした。')) }
  })
}
