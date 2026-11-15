import type { APIRequestContext, Page } from '@playwright/test'

// Lab fixtures (e2e/lab/start-lab.sh). Names mirror production so selectors match.
export const PRIMARY = { name: 'Pi-Hole-Node-1', mock: 'http://127.0.0.1:18081' }
export const REPLICA = { name: 'Pi-Hole-Node-2', mock: 'http://127.0.0.1:18082' }

export type MockWrite = { method: string; path: string; body: unknown }

/** Every mutating request a mock Pi-hole has received since its last reset. */
export async function mockWrites(mock: string): Promise<MockWrite[]> {
  return (await fetch(`${mock}/__writes`)).json()
}
export async function resetMock(mock: string): Promise<void> {
  await fetch(`${mock}/__reset`, { method: 'POST' })
}
export async function setMockOffline(mock: string): Promise<void> {
  await fetch(`${mock}/__offline`, { method: 'POST' })
}

/** { primaryId, replicaId } of the two lab instances, by name. */
export async function instanceIds(request: APIRequestContext): Promise<{ primaryId: string; replicaId: string }> {
  const rows: { id: string; name: string }[] = await (await request.get('/api/instances')).json()
  const primaryId = rows.find((r) => r.name === PRIMARY.name)?.id
  const replicaId = rows.find((r) => r.name === REPLICA.name)?.id
  if (!primaryId || !replicaId) throw new Error('lab instances missing: did global-setup run against the lab?')
  return { primaryId, replicaId }
}

export async function setPrimary(request: APIRequestContext, id: string | null): Promise<void> {
  const res = await request.put('/api/settings', { data: { primaryInstanceId: id } })
  if (!res.ok()) throw new Error(`set primary failed: ${res.status()}`)
}

/**
 * Log in through the form. Waits for hydration first: a click that lands before
 * React hydrates does a native form POST without the CSRF token (Auth.js
 * MissingCSRF) and never redirects. Retries once for the same reason.
 */
export async function login(page: Page, baseURL: string, username: string, password: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    await page.goto(`${baseURL}/login`)
    await page.waitForLoadState('networkidle')
    await page.fill('#username', username)
    await page.fill('#password', password)
    await page.click('button[type="submit"]')
    try {
      await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 90_000 })
      return
    } catch (e) {
      if (attempt >= 2) throw e
    }
  }
}

/** The instance picker on the domains/adlists pages (the select offering "All Instances"). */
export function instancePicker(page: Page) {
  return page.locator('select:has(option[value="__all__"])')
}
