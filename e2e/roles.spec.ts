import { test, expect, type Browser, type BrowserContext } from '@playwright/test'
import { login } from './helpers'

// A role change or deletion takes effect on the user's NEXT request, not when
// their 30-day session token happens to expire. The token is re-checked against
// the users table on every auth() call, including in src/proxy.ts. Since P3.1
// (audit R1-F1) a demotion also ends the user's sessions (token_version bump),
// so a copied admin cookie cannot linger as a viewer; a promotion does not.

const USER = 'e2e-role-user'
const PASS = 'e2e-role-pass-123'

async function userContext(browser: Browser, baseURL: string): Promise<BrowserContext> {
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } })
  await login(await ctx.newPage(), baseURL, USER, PASS)
  return ctx
}

test.describe.serial('role changes take effect immediately', () => {
  let userId = ''
  let ctx: BrowserContext

  test.beforeAll(async ({ request }) => {
    const { users } = (await (await request.get('/api/users')).json()) as { users: { id: string; username: string }[] }
    const existing = users.find((u) => u.username === USER)
    if (existing) await request.delete(`/api/users/${existing.id}`)
    const res = await request.post('/api/users', { data: { username: USER, password: PASS, role: 'admin' } })
    expect(res.status()).toBe(201)
    userId = (await res.json()).id
  })

  test.afterAll(async ({ request }) => {
    await ctx?.close()
    if (userId) await request.delete(`/api/users/${userId}`)
  })

  test('a freshly logged-in admin can use admin APIs', async ({ browser, baseURL }) => {
    ctx = await userContext(browser, baseURL!)
    expect((await ctx.request.get('/api/users')).status()).toBe(200)
  })

  test('demoted to viewer: the old session ends at once; signing in again gives a viewer', async ({ request, browser, baseURL }) => {
    expect((await request.patch(`/api/users/${userId}`, { data: { role: 'viewer' } })).status()).toBe(200)
    expect((await ctx.request.get('/api/users')).status()).toBe(401)
    expect((await ctx.request.get('/api/stats/summary')).status()).toBe(401)
    await ctx.close()
    ctx = await userContext(browser, baseURL!)
    expect((await ctx.request.get('/api/users')).status()).toBe(403)
    expect((await ctx.request.get('/api/stats/summary')).status()).toBe(200)
    const session = await (await ctx.request.get('/api/auth/session')).json()
    expect(session?.user?.role).toBe('viewer')
  })

  test('demoted: admin pages redirect to the overview', async ({ request }) => {
    // Guard against passing vacuously if the proxy ever stops running here
    // (as the misplaced root middleware.ts did under next dev).
    const probe = await request.get('/login', { maxRedirects: 0 })
    expect(probe.status(), 'proxy must redirect a signed-in /login').toBeGreaterThanOrEqual(300)
    const page = await ctx.newPage()
    await page.goto('/settings/domains')
    await expect(page).toHaveURL(/\/$/)
    await page.close()
  })

  test('promoted back to admin: admin APIs work again', async ({ request }) => {
    expect((await request.patch(`/api/users/${userId}`, { data: { role: 'admin' } })).status()).toBe(200)
    expect((await ctx.request.get('/api/users')).status()).toBe(200)
  })

  test('demoted again: the very next page load goes to sign-in, no session refresh needed', async ({ request }) => {
    expect((await request.patch(`/api/users/${userId}`, { data: { role: 'viewer' } })).status()).toBe(200)
    const page = await ctx.newPage()
    await page.goto('/settings/users')
    await expect(page).toHaveURL(/\/login/)
    await page.close()
  })

  test('deleted: the next request is unauthenticated', async ({ request }) => {
    expect((await request.delete(`/api/users/${userId}`)).status()).toBe(200)
    userId = ''
    expect((await ctx.request.get('/api/stats/summary', { maxRedirects: 0 })).status()).toBe(401)
    const session = await (await ctx.request.get('/api/auth/session')).json()
    expect(session?.user ?? null).toBeNull()
  })
})

test.describe('unauthenticated requests', () => {
  test.use({ storageState: { cookies: [], origins: [] } })

  test('API calls get a JSON 401, not a redirect to the login page', async ({ request }) => {
    for (const path of ['/api/stats/summary', '/api/users', '/api/ssh/host-keys']) {
      const res = await request.get(path, { maxRedirects: 0 })
      expect(res.status(), path).toBe(401)
      expect((await res.json()).error).toBe('Unauthorized')
    }
    const put = await request.put('/api/settings', { data: {}, maxRedirects: 0 })
    expect(put.status()).toBe(401)
  })

  test('pages redirect to /login', async ({ request }) => {
    const res = await request.get('/settings/domains', { maxRedirects: 0 })
    expect([302, 307]).toContain(res.status())
    expect(res.headers()['location']).toContain('/login')
  })
})
