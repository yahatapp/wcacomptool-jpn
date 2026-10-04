import type { Plugin } from 'vite'
import { readFile } from 'node:fs/promises'

// or-tools-wasm 1.0.0 registers every solver's assets in each entry point.
// Keep only CP-SAT's JSPI and Asyncify variants before Vite emits URL assets.
export function cpSatAssets(): Plugin {
  return {
    name: 'cp-sat-assets',
    enforce: 'pre',
    async load(id) {
      if (!id.includes('/or-tools-wasm/build/javascript/browser/') || !id.endsWith('.js')) return
      const code = await readFile(id, 'utf8')
      const declaration = /(?:var|const) runtimeAssets = \{/.exec(code)
      if (!declaration) return
      const start = declaration.index
      const next = code.indexOf('\n  routing_runtime:', start)
      const end = code.indexOf('\n};', next)
      if (next < 0 || end < 0) throw new Error('or-tools-wasm の配布形式が変わりました。CP-SAT のアセット設定を確認してください。')
      const assets = code.slice(start, next).replace(/,\s*$/, '') + '\n};'
      return { code: code.slice(0, start) + assets + code.slice(end + 3), map: null }
    },
  }
}
