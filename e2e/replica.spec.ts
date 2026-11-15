import { test, expect } from '@playwright/test'
import { PRIMARY, REPLICA, instanceIds, instancePicker, mockWrites, resetMock, setMockOffline, setPrimary } from './helpers'

// Config editors are Node-1-only: nebula-sync overwrites the replicas from the
// primary, so the API refuses config writes to any other node (409), and the
// editor pages show replicas read-only. Temp-allow is deliberately unguarded
// (it writes to every node and its revert must work everywhere).

test.describe.serial('replica guard (API)', () => {
  let primaryId = '', replicaId = ''

  test.beforeAll(async ({ request }) => {
    ;({ primaryId, replicaId } = await instanceIds(request))
  })
  test.afterAll(async ({ request }) => {
    await setPrimary(request, primaryId) // leave the lab as global-setup made it
    await resetMock(PRIMARY.mock)
  })

  test('primary setting: validation and read-back', async ({ request }) => {
    expect((await request.put('/api/settings', { data: { primaryInstanceId: 'does-not-exist' } })).status()).toBe(400)
    await setPrimary(request, null)
    expect((await (await request.get('/api/settings')).json()).primaryInstanceId).toBeNull()
    await setPrimary(request, primaryId)
    const s = await (await request.get('/api/settings')).json()
    expect([s.primaryInstanceId, s.primaryInstanceName]).toEqual([primaryId, PRIMARY.name])
  })

  test('with no primary set, the replica is writable (unchanged behaviour)', async ({ request }) => {
    await setPrimary(request, null)
    const res = await request.post(`/api/pihole/${replicaId}/domains`, { data: { domain: 'pre.example.com', list: 'deny' } })
    expect(res.status()).toBe(200)
    await request.delete(`/api/pihole/${replicaId}/domains`, { data: { domain: 'pre.example.com', list: 'deny', kind: 'exact' } })
    await setPrimary(request, primaryId)
  })

  test('every config write to the replica is refused and never reaches it', async ({ request }) => {
    await resetMock(REPLICA.mock)
    const base = encodeURIComponent(`https://example.com/node2-base.txt`)
    const calls: [string, string, unknown?][] = [
      ['POST', `/api/pihole/${replicaId}/domains`, { domain: 'x.example.com', list: 'deny' }],
      ['DELETE', `/api/pihole/${replicaId}/domains`, { domain: 'x.example.com', list: 'deny', kind: 'exact' }],
      ['POST', `/api/pihole/${replicaId}/lists`, { address: 'https://example.com/x.txt' }],
      ['PUT', `/api/pihole/${replicaId}/lists/1`, { address: 'https://example.com/node2-base.txt', enabled: false }],
      ['DELETE', `/api/pihole/${replicaId}/lists/${base}`],
      ['POST', `/api/pihole/${replicaId}/clients`, { client: '10.0.0.50' }],
      ['PUT', `/api/pihole/${replicaId}/clients`, { client: '10.0.0.50', groups: [0] }],
      ['DELETE', `/api/pihole/${replicaId}/clients`, { client: '10.0.0.50' }],
    ]
    for (const [method, url, data] of calls) {
      const res = await request.fetch(url, { method, data })
      expect(res.status(), `${method} ${url}`).toBe(409)
      const body = await res.json()
      expect(body).toMatchObject({ code: 'replica_read_only', primaryId, primaryName: PRIMARY.name })
    }
    expect(await mockWrites(REPLICA.mock)).toEqual([])
  })

  test('the same writes on the primary go through', async ({ request }) => {
    await resetMock(PRIMARY.mock)
    const calls: [string, string, unknown][] = [
      ['POST', `/api/pihole/${primaryId}/domains`, { domain: 'x.example.com', list: 'deny' }],
      ['DELETE', `/api/pihole/${primaryId}/domains`, { domain: 'x.example.com', list: 'deny', kind: 'exact' }],
      ['POST', `/api/pihole/${primaryId}/lists`, { address: 'https://example.com/x.txt' }],
      ['PUT', `/api/pihole/${primaryId}/lists/1`, { address: 'https://example.com/node1-base.txt', enabled: false }],
      ['POST', `/api/pihole/${primaryId}/clients`, { client: '10.0.0.50' }],
      ['PUT', `/api/pihole/${primaryId}/clients`, { client: '10.0.0.50', groups: [0, 1] }],
      ['DELETE', `/api/pihole/${primaryId}/clients`, { client: '10.0.0.50' }],
    ]
    for (const [method, url, data] of calls) {
      const res = await request.fetch(url, { method, data })
      expect(res.ok(), `${method} ${url} -> ${res.status()}`).toBe(true)
    }
    expect(await mockWrites(PRIMARY.mock)).toHaveLength(calls.length)
  })

  test('temp-allow is not blocked on the replica', async ({ request }) => {
    const res = await request.post(`/api/pihole/${replicaId}/temp-allow`, { data: { domain: 'tmp.example.com', durationMinutes: 5 } })
    expect(res.status()).not.toBe(409)
    const { tempAllows = [] } = await (await request.get(`/api/pihole/${replicaId}/temp-allow`)).json()
    for (const t of tempAllows) await request.delete(`/api/pihole/${replicaId}/temp-allow`, { data: { id: t.id } })
  })
})

test.describe.serial('replica guard (editor UI)', () => {
  test('domains: opens on the primary, replica read-only, merged view locks replica rows', async ({ page, request }) => {
    const { primaryId, replicaId } = await instanceIds(request)
    await request.post(`/api/pihole/${primaryId}/domains`, { data: { domain: 'both.example.com', list: 'allow' } })
    await setPrimary(request, null)
    await request.post(`/api/pihole/${replicaId}/domains`, { data: { domain: 'both.example.com', list: 'allow' } })
    await setPrimary(request, primaryId)

    await page.goto('/settings/domains')
    await page.waitForLoadState('networkidle')
    await expect(instancePicker(page).locator('option:checked')).toHaveText(PRIMARY.name)
    await expect(page.getByText(`Changes are made on ${PRIMARY.name}`)).toBeVisible()

    await instancePicker(page).selectOption({ label: REPLICA.name })
    await expect(page.getByText('Read-only replica.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Add Domain' })).toHaveCount(0)

    await instancePicker(page).selectOption('__all__')
    const r1 = page.locator('tbody tr').filter({ hasText: PRIMARY.name }).first()
    const r2 = page.locator('tbody tr').filter({ hasText: REPLICA.name }).first()
    await expect(r1.getByRole('button', { name: /Remove/ })).toHaveCount(1)
    await expect(r2.getByRole('button', { name: /Remove/ })).toHaveCount(0)
    await page.getByRole('button', { name: 'Add Domain' }).click()
    await expect(page.getByText('Add to instances')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Kids', exact: true })).toBeVisible()
  })

  test('clients: replica has no add form; "Edit on" returns to the primary', async ({ page, request }) => {
    const { primaryId, replicaId } = await instanceIds(request)
    await page.goto('/settings/clients')
    await page.waitForLoadState('networkidle')
    const sel = page.locator('select').first()
    await expect(sel).toHaveValue(primaryId)
    await expect(page.getByPlaceholder('192.168.1.50')).toBeVisible()
    await sel.selectOption(replicaId)
    await expect(page.getByPlaceholder('192.168.1.50')).toHaveCount(0)
    await page.getByRole('button', { name: `Edit on ${PRIMARY.name}` }).click()
    await expect(sel).toHaveValue(primaryId)
  })

  test('sync page shows the saved primary', async ({ page, request }) => {
    const { primaryId } = await instanceIds(request)
    await page.goto('/settings/sync')
    await expect(page.getByLabel('Primary node')).toHaveValue(primaryId)
  })

  test('no primary set: amber banner', async ({ page, request }) => {
    const { primaryId } = await instanceIds(request)
    await setPrimary(request, null)
    try {
      await page.goto('/settings/domains')
      await expect(page.getByText('No primary node chosen.')).toBeVisible()
    } finally {
      await setPrimary(request, primaryId)
    }
  })

  test('primary offline: edits paused, Add hidden', async ({ page }) => {
    await setMockOffline(PRIMARY.mock)
    try {
      await page.goto('/settings/domains')
      await expect(page.getByText(`Edits paused: ${PRIMARY.name} is offline.`)).toBeVisible()
      await expect(page.getByRole('button', { name: 'Add Domain' })).toHaveCount(0)
    } finally {
      await resetMock(PRIMARY.mock)
    }
  })
})
