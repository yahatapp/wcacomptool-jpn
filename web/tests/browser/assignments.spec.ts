import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const registration = fileURLToPath(new URL('../../public/samples/registration.csv', import.meta.url))

async function sample(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'サンプルで試す' }).click()
  await expect(page.getByLabel('大会名', { exact: true })).toHaveValue('SampleCompetition')
  await page.getByLabel('競技卓数', { exact: true }).fill('3')
}

test('sample solves entirely in-browser, exports CSV and checks it without an API', async ({ page }) => {
  const apiCalls: string[] = [], wasm: string[] = [], errors: string[] = []
  const forceAsyncify = process.env.PLAYWRIGHT_DISABLE_JSPI === '1'
  if (forceAsyncify) {
    // Recent Chromium releases always expose JSPI. Hide its API in the solver
    // worker to exercise the real fallback rather than relying on V8 flags.
    await page.route(/\/solver\.worker(?:\.ts|-[^/?]+\.js)(?:\?.*)?$/, async (route) => {
      const response = await route.fetch()
      await route.fulfill({ response, body: `delete WebAssembly.promising;\n${await response.text()}` })
    })
  }
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/')) apiCalls.push(request.url())
    if (request.url().includes('.wasm')) wasm.push(request.url())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  await sample(page)
  await page.getByLabel('競技卓数', { exact: true }).fill('2')
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true)
  const jspi = !forceAsyncify && await page.evaluate(() => typeof (WebAssembly as typeof WebAssembly & { promising?: unknown }).promising === 'function')
  await page.getByRole('button', { name: '役割分担を計算する', exact: true }).click()
  await expect(page.getByText('制約検証済み', { exact: false })).toBeVisible()
  expect(wasm.some((url) => url.includes('cp_sat_runtime'))).toBe(true)
  expect(wasm.some((url) => url.includes('asyncify'))).toBe(!jspi)
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '結果CSVをダウンロード' }).click()
  const download = await downloadPromise, path = await download.path()
  const result = await readFile(path!)
  expect(result.toString('utf8')).toContain('Name,333,444')
  expect(result.toString('utf8')).toContain('J')
  await page.getByLabel('照合用の登録CSV（元CSV）', { exact: false }).setInputFiles(registration)
  await page.getByLabel('照合用の結果CSV', { exact: true }).setInputFiles({ name: 'result.csv', mimeType: 'text/csv', buffer: result })
  await page.getByRole('switch', { name: '競技卓数に対するジャッジ人数' }).click()
  await page.getByRole('button', { name: '選択した項目をチェック' }).click()
  await expect(page.getByText('選択したすべてのチェックを通過しました。')).toBeVisible()
  const check = page.getByRole('region', { name: 'CSVの割り当てをチェック' })
  await expect(check.getByRole('columnheader', { name: '必要ジャッジ人数' })).toBeVisible()
  for (const row of (await check.getByRole('row').all()).slice(1)) {
    const cells = await row.getByRole('cell').allTextContents()
    const required = Math.min(Number.parseInt(cells[0]), 2)
    expect(cells[1]).toBe(`${required}人`)
    expect(cells[2]).toBe(`${required}人`)
    expect(cells[5]).toBe('OK')
  }
  expect(apiCalls).toEqual([]); expect(errors).toEqual([])
  // A second solve must work after releasing the previous WASM workers.
  await page.getByRole('button', { name: '役割分担を計算する', exact: true }).click()
  await expect(page.getByText('制約検証済み', { exact: false })).toBeVisible()
})

test('cancelling engine startup releases the worker and allows another solve', async ({ page }) => {
  await page.route('**/*cp_sat_runtime*.wasm*', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500))
    await route.continue().catch(() => undefined)
  })
  await sample(page)
  await page.getByRole('button', { name: '役割分担を計算する', exact: true }).click()
  await page.getByRole('button', { name: '計算を中止する' }).click()
  await expect(page.getByRole('button', { name: '役割分担を計算する', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: '結果CSVをダウンロード' })).toHaveCount(0)
  await page.unroute('**/*cp_sat_runtime*.wasm*')
  await page.getByRole('button', { name: '役割分担を計算する', exact: true }).click()
  await expect(page.getByText('制約検証済み', { exact: false })).toBeVisible()
})

test('missing isolation headers produce a useful error without returning a CSV', async ({ page }) => {
  await page.route('**/', async (route) => {
    const response = await route.fetch(), headers = response.headers()
    delete headers['cross-origin-opener-policy']; delete headers['cross-origin-embedder-policy']
    await route.fulfill({ response, headers })
  })
  await sample(page)
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(false)
  await page.getByRole('button', { name: '役割分担を計算する', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('COOP・COEP')
  await expect(page.getByRole('button', { name: '結果CSVをダウンロード' })).toHaveCount(0)
})

test('official records go directly to WCA and repeated imports use the browser cache', async ({ page }) => {
  const requests: string[] = [], localApiCalls: string[] = []
  await page.route('**/samples/registration.csv', async (route) => {
    const body = (await readFile(registration, 'utf8')).replace('TEST0001', '2009ZEMD01')
    await route.fulfill({ contentType: 'text/csv', body })
  })
  const endpoint = 'https://www.worldcubeassociation.org/api/v0/persons/2009ZEMD01/personal_records'
  await page.route(endpoint, async (route) => {
    const request = route.request()
    requests.push(request.url())
    expect(request.method()).toBe('GET')
    expect(request.postData()).toBe(null)
    expect(request.headers().referer).toBeUndefined()
    await route.fulfill({
      contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify([{ eventId: '333', type: 'average', best: 553 }]),
    })
  })
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.origin === new URL(page.url()).origin && url.pathname.startsWith('/api/')) localApiCalls.push(url.href)
  })
  await sample(page)
  const fetch = page.getByRole('button', { name: 'WCAから自己ベスト・平均記録を取得', exact: true })
  await fetch.click()
  await expect(page.getByText(/取得完了：1 \/ 1件/)).toBeVisible()
  await page.getByText('自己ベスト・平均記録を補完する', { exact: true }).click()
  await expect(page.getByLabel('サンプル参加者01 平均記録', { exact: true })).toHaveValue('5.53')
  await fetch.click()
  await expect(page.getByText(/キャッシュ利用 1件/)).toBeVisible()
  expect(requests).toEqual([endpoint])
  expect(localApiCalls).toEqual([])
})
