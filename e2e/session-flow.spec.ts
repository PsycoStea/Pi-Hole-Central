import { test, expect } from '@playwright/test'
import { login } from './helpers'

// P3 in a real browser (lab only). The proxy now refuses state-changing API
// calls unless the browser's own Sec-Fetch-Site / Origin say same-origin, and
// sessions end on a password change: this walks the owner's everyday path to
// prove neither locks them out. A throwaway admin keeps the suite's shared
// `admin` session (e2e/.auth.json) untouched.
test('sign in, live Overview, a save, own password change, sign out', async ({ browser, request, baseURL }) => {
  const username = `e2e-flow-${Date.now()}`
  const first = 'flow-pass-first-1'
  const second = 'flow-pass-second-2'
  const created = await request.post('/api/users', { data: { username, password: first, role: 'admin' } })
  expect(created.status()).toBe(201)
  const { id } = await created.json()

  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } })
  const page = await ctx.newPage()
  try {
    // Sign in through the form; Overview opens the live stream.
    const stream = page.waitForResponse((r) => r.url().endsWith('/api/events'), { timeout: 60_000 })
    await login(page, baseURL!, username, first)
    expect((await stream).status()).toBe(200)

    // A save, sent by the browser itself (real Sec-Fetch-Site and Origin).
    // Writes back the current retention, so nothing changes.
    const saved = await page.evaluate(async () => {
      const cur = await (await fetch('/api/settings')).json()
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ retentionDays: cur.retentionDays }),
      })
      return res.status
    })
    expect(saved).toBe(200)

    // Own password change on the Account page: ends this session too, so the
    // page sends us to the sign-in page with a notice.
    await page.goto(`${baseURL}/settings/account`)
    await page.waitForLoadState('networkidle')
    const inputs = page.locator('form input[type="password"]')
    await inputs.nth(0).fill(first)
    await inputs.nth(1).fill(second)
    await inputs.nth(2).fill(second)
    await page.click('form button[type="submit"]')
    await page.waitForURL(/\/login\?reason=password-changed/, { timeout: 30_000 })
    await expect(page.getByRole('status')).toContainText('Password changed')

    // The old session is gone; the new password works.
    expect(await page.evaluate(async () => (await fetch('/api/stats/summary')).status)).toBe(401)
    await login(page, baseURL!, username, second)
    expect(await page.evaluate(async () => (await fetch('/api/stats/summary')).status)).toBe(200)

    // Sign out from the UI.
    await page.getByRole('button', { name: 'Sign out' }).first().click()
    await page.waitForURL(/\/login/, { timeout: 30_000 })
    expect(await page.evaluate(async () => (await fetch('/api/stats/summary')).status)).toBe(401)
  } finally {
    await ctx.close()
    await request.delete(`/api/users/${id}`)
  }
})
