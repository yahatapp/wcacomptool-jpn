import type { SolveRequest, SolveResponse } from './assignments.ts'
import { solve } from './solver.ts'

export type SolverMessage = { type: 'result'; result: SolveResponse } | { type: 'error'; message: string }

// One worker owns one solve, including model building, WASM and result validation.
self.onmessage = async (event: MessageEvent<SolveRequest>) => {
  try {
    const count = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 2) - 1))
    const result = await solve(event.data, count)
    self.postMessage({ type: 'result', result } satisfies SolverMessage)
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : '役割分担の計算に失敗しました。' } satisfies SolverMessage)
  }
}
