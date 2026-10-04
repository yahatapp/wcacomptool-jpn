import { defineConfig } from '@playwright/test'

const externalServer = process.env.PLAYWRIGHT_BASE_URL

export default defineConfig({
  testDir: './tests/browser',
  timeout: 45_000,
  expect: { timeout: 15_000 },
  workers: 1,
  use: {
    baseURL: externalServer || 'http://127.0.0.1:3101',
    headless: true,
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    },
  },
  webServer: externalServer ? undefined : {
    command: `"${process.execPath}" node_modules/vite/bin/vite.js dev --host 127.0.0.1 --port 3101 --strictPort`,
    url: 'http://127.0.0.1:3101',
    reuseExistingServer: !process.env.CI,
    env: { WCA_TEST_CACHE_DIR: 'node_modules/.vite-wasm-tests' },
    timeout: 60_000,
  },
})
