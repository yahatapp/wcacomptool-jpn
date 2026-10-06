import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const registration = fileURLToPath(new URL('../../public/samples/registration.csv', import.meta.url))
const workspace = (page: Page) => page.getByRole('region', { name: '大会ワークスペース', exact: true })
const savedFiles = (page: Page) => page.getByRole('region', { name: '保存したCSV・結果履歴', exact: true })
async function saved(page: Page) {
  await expect(workspace(page).getByRole('status')).toHaveText('保存済み')
}
async function sample(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'サンプルで試す' }).click()
  await expect(page.getByLabel('大会名', { exact: true })).toHaveValue('SampleCompetition')
  await page.getByLabel('競技卓数', { exact: true }).fill('2')
}

test('workspace restores CSV bytes, edited settings and result history after reload', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await sample(page)
  await page.getByLabel('大会名', { exact: true }).fill('大会A')
  await page.getByLabel('サンプル参加者01 年齢', { exact: true }).fill('37')
  await page.getByText('自己ベスト・平均記録を補完する', { exact: true }).click()
  await page.getByLabel('サンプル参加者01 平均記録', { exact: true }).fill('5.53')
  await saved(page)
  const download = page.waitForEvent('download')
  await savedFiles(page).getByRole('button', { name: 'SampleCompetition-registration.csvをダウンロード', exact: true }).click()
  expect(await readFile((await (await download).path())!)).toEqual(await readFile(registration))
  await page.getByRole('button', { name: '役割分担を計算する', exact: true }).click()
  await expect(page.getByText('制約検証済み', { exact: false })).toBeVisible()
  await expect(savedFiles(page).getByRole('heading', { name: '結果CSVの履歴（1件）' })).toBeVisible()
  await saved(page)
  const resultDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: '結果CSVをダウンロード', exact: true }).click()
  const result = await readFile((await (await resultDownload).path())!)
  await page.reload()
  await expect(page.getByLabel('大会名', { exact: true })).toHaveValue('大会A')
  await expect(page.getByLabel('競技卓数', { exact: true })).toHaveValue('2')
  await expect(page.getByLabel('サンプル参加者01 年齢', { exact: true })).toHaveValue('37')
  await expect(page.getByText('制約検証済み', { exact: false })).toBeVisible()
  await page.getByText('自己ベスト・平均記録を補完する', { exact: true }).click()
  await expect(page.getByLabel('サンプル参加者01 平均記録', { exact: true })).toHaveValue('5.53')
  // The saved inputs and output are immediately usable without file pickers.
  await page.getByRole('button', { name: '選択した項目をチェック' }).click()
  await expect(page.getByText('選択したすべてのチェックを通過しました。')).toBeVisible()
  await page.getByLabel('競技卓数', { exact: true }).fill('3')
  await expect(page.getByRole('button', { name: '結果CSVをダウンロード', exact: true })).toHaveCount(0)
  await expect(savedFiles(page).getByRole('heading', { name: '結果CSVの履歴（1件）' })).toBeVisible()
  await savedFiles(page).getByRole('button', { name: 'この結果と設定を開く', exact: true }).click()
  await expect(page.getByLabel('競技卓数', { exact: true })).toHaveValue('2')
  const historyDownload = page.waitForEvent('download')
  await savedFiles(page).getByRole('button', { name: /assignments-.*をダウンロード/ }).click()
  expect(await readFile((await (await historyDownload).path())!)).toEqual(result)
  await page.getByRole('button', { name: '役割分担を計算する', exact: true }).click()
  await expect(savedFiles(page).getByRole('heading', { name: '結果CSVの履歴（2件）' })).toBeVisible()
  await saved(page)
  await page.reload()
  await expect(savedFiles(page).getByRole('heading', { name: '結果CSVの履歴（2件）' })).toBeVisible()
  expect(errors).toEqual([])
})

test('competitions isolate files and checker state, and deletion keeps the other competition', async ({ page }) => {
  await sample(page)
  await page.getByLabel('大会名', { exact: true }).fill('大会A')
  await saved(page)
  const first = await page.getByLabel('保存した大会', { exact: true }).inputValue()
  await page.getByRole('button', { name: '大会を追加', exact: true }).click()
  await expect(page.getByLabel('大会の表示名', { exact: true })).toHaveValue('')
  await page.getByLabel('大会の表示名', { exact: true }).fill('大会B')
  const second = await page.getByLabel('保存した大会', { exact: true }).inputValue()
  await page.getByLabel('大会で使うCSVを追加', { exact: true }).setInputFiles([
    { name: 'result.csv', mimeType: 'text/csv', buffer: Buffer.from('Name,333\nAlice,1;J1\n') },
    { name: 'another.csv', mimeType: 'text/csv', buffer: Buffer.from('Name,333\nBob,1;J1\n') },
  ])
  await expect(savedFiles(page).getByRole('listitem')).toHaveCount(2)
  await page.getByRole('switch', { name: '参加競技の一致', exact: true }).click()
  await page.getByRole('switch', { name: '競技卓数に対するジャッジ人数', exact: true }).click()
  await page.getByLabel('保存済みの結果CSVを選ぶ').selectOption({ label: 'result.csv' })
  await page.getByRole('button', { name: '選択した項目をチェック' }).click()
  await expect(page.getByText('選択したすべてのチェックを通過しました。')).toBeVisible()
  await saved(page)
  await page.reload()
  await expect(page.getByLabel('大会の表示名', { exact: true })).toHaveValue('大会B')
  await expect(page.getByRole('switch', { name: '参加競技の一致', exact: true })).not.toBeChecked()
  await page.getByRole('button', { name: '選択した項目をチェック' }).click()
  await expect(page.getByText('選択したすべてのチェックを通過しました。')).toBeVisible()
  await page.getByLabel('保存した大会', { exact: true }).selectOption(first)
  await expect(page.getByLabel('大会名', { exact: true })).toHaveValue('大会A')
  await expect(savedFiles(page).getByText('result.csv', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('switch', { name: '参加競技の一致', exact: true })).toBeChecked()
  // Switching immediately after an edit waits for the write queue.
  await page.getByLabel('大会名', { exact: true }).fill('大会A更新')
  await page.getByLabel('保存した大会', { exact: true }).selectOption(second)
  await expect(page.getByLabel('大会の表示名', { exact: true })).toHaveValue('大会B')
  await page.getByLabel('保存した大会', { exact: true }).selectOption(first)
  await expect(page.getByLabel('大会名', { exact: true })).toHaveValue('大会A更新')
  await saved(page)
  await page.getByRole('button', { name: '大会を削除', exact: true }).click()
  await page.getByRole('button', { name: 'この大会を削除する', exact: true }).click()
  await expect(page.getByLabel('大会の表示名', { exact: true })).toHaveValue('大会B')
  await expect(savedFiles(page).getByRole('listitem')).toHaveCount(2)
  await expect(page.getByLabel('保存した大会', { exact: true }).getByRole('option')).toHaveCount(1)
  await page.reload()
  await expect(savedFiles(page).getByRole('listitem')).toHaveCount(2)
})

test('storage write failures leave existing CSVs intact and allow retry', async ({ page }) => {
  await sample(page)
  await saved(page)
  await page.evaluate(() => {
    const prototype = FileSystemFileHandle.prototype
    const original = prototype.createWritable
    Object.assign(window, { restoreWorkspaceWrites: () => { prototype.createWritable = original } })
    prototype.createWritable = async () => { throw new DOMException('Disk full', 'QuotaExceededError') }
  })
  await page.getByLabel('大会で使うCSVを追加', { exact: true }).setInputFiles({
    name: 'failed.csv', mimeType: 'text/csv', buffer: Buffer.from('Name,333\nAlice,1;J1\n'),
  })
  await expect(workspace(page).getByRole('alert')).toContainText('保存容量が不足')
  await expect(workspace(page).getByRole('status')).toHaveText('未保存')
  await expect(savedFiles(page).getByRole('listitem')).toHaveCount(1)
  await page.evaluate(() => (window as typeof window & { restoreWorkspaceWrites: () => void }).restoreWorkspaceWrites())
  await page.getByRole('button', { name: '保存を再試行', exact: true }).click()
  await saved(page)
  await page.getByLabel('大会で使うCSVを追加', { exact: true }).setInputFiles({
    name: 'retry.csv', mimeType: 'text/csv', buffer: Buffer.from('Name,333\nAlice,1;J1\n'),
  })
  await expect(savedFiles(page).getByRole('listitem')).toHaveCount(2)
  await saved(page)
  await page.reload()
  await expect(savedFiles(page).getByRole('listitem')).toHaveCount(2)
})

test('another tab cannot silently overwrite newer edits', async ({ page, context }) => {
  await sample(page)
  await page.getByLabel('大会名', { exact: true }).fill('大会A')
  await saved(page)
  const other = await context.newPage()
  await other.goto('/')
  await expect(other.getByLabel('大会名', { exact: true })).toHaveValue('大会A')
  await saved(other)
  await other.getByLabel('大会名', { exact: true }).fill('新しい編集')
  await saved(other)
  await page.getByLabel('大会名', { exact: true }).fill('古いタブからの編集')
  await expect(workspace(page).getByRole('alert')).toContainText('別のタブ')
  await other.reload()
  await expect(other.getByLabel('大会名', { exact: true })).toHaveValue('新しい編集')
})
