import { test, expect, type APIRequestContext } from '@playwright/test'
import { instanceIds } from './helpers'

// unbound_down against the lab's mock sshd (e2e/lab/mock-sshd.mjs), which
// answers the minute Unbound check as running / stopped / hung. Both lab
// instances are 127.0.0.1 and share the mock, so both raise and clear together.
//
// The check runs every minute at second :30 (src/lib/unbound/status-cache.ts)
// and needs two bad readings in a row, so this spec is slow by design (~5 min).

const SSHD = 'http://127.0.0.1:18023'
const setUnbound = (state: 'running' | 'stopped' | 'hung') =>
  fetch(`${SSHD}/__unbound`, { method: 'POST', body: JSON.stringify({ state }) })

type Live = { type: string; title: string; message: string; severity: string; instanceId: string | null }

async function unboundAlerts(request: APIRequestContext): Promise<Live[]> {
  // Live (unresolved) conditions are returned in `active`, separate from the feed.
  const { active } = await (await request.get('/api/notifications?limit=50')).json()
  return (active as Live[]).filter((n) => n.type === 'unbound_down')
}

/** Resolve once the wall clock is at second :32-:40, just after a check ran. */
async function justAfterACheck(): Promise<void> {
  for (;;) {
    const s = new Date().getSeconds()
    if (s >= 32 && s <= 40) return
    await new Promise((r) => setTimeout(r, 500))
  }
}

test.describe.serial('Unbound Down alert', () => {
  let ids: string[] = []

  test.beforeAll(async ({ request }) => {
    test.setTimeout(420_000)
    await setUnbound('running')
    const { primaryId, replicaId } = await instanceIds(request)
    ids = [primaryId, replicaId]
    // Earlier specs take a mock Pi-hole offline; an offline node is not checked
    // (status "unknown"), so wait until both have a fresh "running" reading.
    await expect
      .poll(
        async () => {
          const rows = await Promise.all(
            ids.map(async (id) => (await request.get(`/api/unbound/${id}/status`)).json())
          )
          return rows.every((r) => r.status === 'running' && Date.now() - Date.parse(r.checkedAt) < 90_000)
        },
        { timeout: 400_000, intervals: [5_000] }
      )
      .toBe(true)
    expect(await unboundAlerts(request)).toEqual([])
  })

  test.afterAll(async () => {
    await setUnbound('running')
  })

  test('the alert type is seeded: in-app on, push off', async ({ request }) => {
    const rows: { type: string; enabled: boolean; pushEnabled: boolean }[] = await (await request.get('/api/alerts')).json()
    expect(rows.find((r) => r.type === 'unbound_down')).toMatchObject({ enabled: true, pushEnabled: false })
  })

  test('stopped: raised as critical on both nodes, only after the second bad check', async ({ request }) => {
    test.setTimeout(240_000)
    await justAfterACheck()
    const started = Date.now()
    await setUnbound('stopped')
    // The badge reflects the process straight away (first check)...
    await expect
      .poll(async () => (await (await request.get(`/api/unbound/${ids[0]}/status`)).json()).status, {
        timeout: 80_000,
        intervals: [2_000],
      })
      .toBe('stopped')
    // ...but no alert yet: one bad reading is not enough.
    expect(await unboundAlerts(request)).toEqual([])

    await expect.poll(async () => (await unboundAlerts(request)).length, { timeout: 150_000, intervals: [3_000] }).toBe(2)
    // The first check after the change was ~58 s in, the second ~118 s.
    expect(Date.now() - started).toBeGreaterThan(90_000)
    for (const a of await unboundAlerts(request)) {
      expect(a.severity).toBe('critical')
      expect(a.title).toMatch(/^Unbound Stopped: Pi-Hole-Node-[12]$/)
      expect(a.message).toContain('systemctl reports "inactive"')
      expect(ids).toContain(a.instanceId)
    }
  })

  test('hung: the same alert changes to "Not Answering"', async ({ request }) => {
    test.setTimeout(120_000)
    await setUnbound('hung')
    await expect
      .poll(async () => (await unboundAlerts(request)).map((a) => a.title.split(':')[0]), {
        timeout: 90_000,
        intervals: [3_000],
      })
      .toEqual(['Unbound Not Answering', 'Unbound Not Answering'])
    const alerts = await unboundAlerts(request)
    expect(alerts[0].message).toContain('timed out')
    // Still one live row per node, updated in place.
    expect(new Set(alerts.map((a) => a.instanceId)).size).toBe(2)
  })

  test('running again: cleared on the first good check', async ({ request }) => {
    test.setTimeout(120_000)
    await setUnbound('running')
    await expect.poll(async () => (await unboundAlerts(request)).length, { timeout: 80_000, intervals: [3_000] }).toBe(0)
  })
})
