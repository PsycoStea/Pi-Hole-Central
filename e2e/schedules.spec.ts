import { test, expect, type APIRequestContext } from '@playwright/test'
import { PRIMARY, REPLICA, instanceIds, mockWrites, resetMock, type MockWrite } from './helpers'

// With a nebula-sync primary set, GROUP schedules switch the group on every
// node at once whatever nodes were picked (groups are synced config: a replica-
// only toggle was undone by the next sync). BLOCKING schedules keep their
// per-node picks (blocking is runtime state, not synced).

const ALL_DAY = { days: [0, 1, 2, 3, 4, 5, 6], startTime: '00:00', endTime: '23:59' }

async function waitForWrites(mock: string, match: (w: MockWrite) => boolean, timeoutMs = 75_000): Promise<MockWrite[]> {
  const until = Date.now() + timeoutMs
  for (;;) {
    const hits = (await mockWrites(mock)).filter(match)
    if (hits.length || Date.now() > until) return hits
    await new Promise((r) => setTimeout(r, 1000))
  }
}

async function createDisabled(request: APIRequestContext, data: Record<string, unknown>): Promise<string> {
  const res = await request.post('/api/schedules', { data: { ...ALL_DAY, ...data, enabled: false } })
  expect(res.status()).toBe(201)
  return (await res.json()).id
}

const groupPut = (enabled: boolean) => (w: MockWrite) =>
  w.method === 'PUT' && w.path === '/api/groups/Kids' && (w.body as { enabled?: boolean }).enabled === enabled

test.describe.serial('schedules and the nebula-sync primary', () => {
  test('a group schedule picked for the replica only switches the group on both nodes', async ({ request }) => {
    const { replicaId } = await instanceIds(request)
    const id = await createDisabled(request, {
      name: 'e2e group window', targetType: 'group', targetGroup: 'Kids', windowState: false, instanceIds: [replicaId],
    })
    try {
      await resetMock(PRIMARY.mock)
      await resetMock(REPLICA.mock)
      // Enabling applies immediately (no wait for the minute tick).
      expect((await request.put('/api/schedules', { data: { id, enabled: true } })).status()).toBe(200)
      expect(await waitForWrites(PRIMARY.mock, groupPut(false))).toHaveLength(1)
      expect(await waitForWrites(REPLICA.mock, groupPut(false))).toHaveLength(1)

      // Disabling mid-window hands the group back on BOTH nodes.
      expect((await request.put('/api/schedules', { data: { id, enabled: false } })).status()).toBe(200)
      expect(await waitForWrites(PRIMARY.mock, groupPut(true))).toHaveLength(1)
      expect(await waitForWrites(REPLICA.mock, groupPut(true))).toHaveLength(1)
    } finally {
      await request.delete('/api/schedules', { data: { id } })
    }
  })

  test('a blocking schedule keeps its per-node pick', async ({ request }) => {
    const { replicaId } = await instanceIds(request)
    const id = await createDisabled(request, {
      name: 'e2e blocking window', targetType: 'blocking', windowState: true, instanceIds: [replicaId],
    })
    try {
      await resetMock(PRIMARY.mock)
      await resetMock(REPLICA.mock)
      expect((await request.put('/api/schedules', { data: { id, enabled: true } })).status()).toBe(200)
      const isBlocking = (w: MockWrite) => w.method === 'POST' && w.path === '/api/dns/blocking'
      expect((await waitForWrites(REPLICA.mock, isBlocking)).length).toBeGreaterThan(0)
      expect((await mockWrites(PRIMARY.mock)).filter(isBlocking)).toEqual([])
    } finally {
      await request.put('/api/schedules', { data: { id, enabled: false } })
      await request.delete('/api/schedules', { data: { id } })
    }
  })

  test('the schedule form says group schedules cover all nodes', async ({ page }) => {
    await page.goto('/settings/schedules')
    await page.getByRole('button', { name: /New|Add/ }).first().click()
    await page.locator('select').filter({ has: page.locator('option[value="group"]') }).selectOption('group')
    await expect(page.getByText(`Groups are copied from ${PRIMARY.name} by nebula-sync`)).toBeVisible()
  })
})
