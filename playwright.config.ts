import { defineConfig, chromium } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'

// Default target is the LOCAL LAB (e2e/lab/start-lab.sh: next dev on :3999 +
// two mock Pi-holes). The suite writes adlists, domains, clients and users,
// so it must never point at the live dashboard by accident.
//
// E2E_BASE_URL may point elsewhere only together with E2E_ALLOW_REMOTE=1, and
// then ONLY the validation-only security spec runs (it is rejected before any
// SSH or Pi-hole call, so it has no side effects).
const BASE_URL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3999'
const isLoopback = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/.test(BASE_URL)
if (!isLoopback && process.env.E2E_ALLOW_REMOTE !== '1') {
  throw new Error(
    `E2E_BASE_URL=${BASE_URL} is not the local lab. The suite writes config; ` +
      'set E2E_ALLOW_REMOTE=1 to run only the read-only security spec against it.'
  )
}

// The pinned @playwright/test may expect a browser build that isn't installed;
// fall back to CHROMIUM_PATH or the newest one cached.
function chromiumPath(): string | undefined {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH
  try {
    if (fs.existsSync(chromium.executablePath())) return undefined
  } catch {
    /* fall through */
  }
  const cache = path.join(os.homedir(), '.cache/ms-playwright')
  if (!fs.existsSync(cache)) return undefined
  return fs
    .readdirSync(cache)
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
    .map((d) => path.join(cache, d, 'chrome-linux64/chrome'))
    .find((p) => fs.existsSync(p))
}

export default defineConfig({
  testDir: './e2e',
  testMatch: isLoopback ? '*.spec.ts' : 'security.spec.ts',
  fullyParallel: false, // specs share one lab DB and two mocks
  retries: 0,
  workers: 1,
  reporter: 'list',
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: BASE_URL,
    headless: true,
    storageState: 'e2e/.auth.json',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    launchOptions: { executablePath: chromiumPath() },
  },
  // next dev compiles each route on first hit; the first test to touch a page pays for it.
  timeout: 120_000,
  expect: { timeout: 15_000 },
})
