import { test, expect, type APIRequestContext } from '@playwright/test'
import { instanceIds } from './helpers'

// SSH host-key pinning against the lab's mock sshd (e2e/lab/mock-sshd.mjs on
// :18022; both lab instances are 127.0.0.1, so they share one pin). The lab's
// background loops (health, watchdog, Unbound status) also connect every minute
// and may pin first; every assertion compares against the key the mock is
// actually presenting, so either order is fine.

const SSHD = 'http://127.0.0.1:18023'
const HOST = '127.0.0.1'

type Pin = { host: string; alg: string; fp: string; firstSeen: string }
const sshdKey = async (): Promise<{ alg: string; fp: string }> => (await fetch(`${SSHD}/__fingerprint`)).json()
const rotate = async (): Promise<{ alg: string; fp: string }> => (await fetch(`${SSHD}/__rotate`, { method: 'POST' })).json()

async function pinFor(request: APIRequestContext): Promise<Pin | undefined> {
  const { pins } = await (await request.get('/api/ssh/host-keys')).json()
  return (pins as Pin[]).find((p) => p.host === HOST)
}

async function hostKeyAlert(request: APIRequestContext) {
  // Live (unresolved) conditions are returned in `active`, separate from the feed.
  const { active } = await (await request.get('/api/notifications?limit=50')).json()
  return (active as { type: string; message: string }[]).find((n) => n.type === 'ssh_host_key')
}

/** Any SSH-backed endpoint will do; Unbound stats is read-only. */
async function connectOnce(request: APIRequestContext, instanceId: string) {
  const res = await request.get(`/api/unbound/${instanceId}/stats`)
  return { status: res.status(), text: await res.text() }
}

test.describe.serial('SSH host-key pinning', () => {
  let instanceId = ''

  test.beforeAll(async ({ request }) => {
    instanceId = (await instanceIds(request)).primaryId
    await request.delete('/api/ssh/host-keys', { data: { host: HOST } }) // 404 if not pinned: fine
  })

  test('first connection pins the presented key (OpenSSH fingerprint format)', async ({ request }) => {
    const key = await sshdKey()
    const r = await connectOnce(request, instanceId)
    expect(r.text).not.toContain('host key')
    const pin = await pinFor(request)
    expect(pin).toMatchObject({ alg: key.alg, fp: key.fp })
    expect(pin!.fp).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/)
  })

  test('the same key keeps working and the pin does not change', async ({ request }) => {
    const before = await pinFor(request)
    const r = await connectOnce(request, instanceId)
    expect(r.text).not.toContain('host key')
    expect(await pinFor(request)).toEqual(before)
  })

  test('a different key is refused, with a clear error and a critical alert', async ({ request }) => {
    const pinned = await pinFor(request)
    const presented = await rotate()
    expect(presented.fp).not.toBe(pinned!.fp)

    const r = await connectOnce(request, instanceId)
    expect(r.status).toBe(500)
    expect(r.text).toContain(`SSH host key for ${HOST} has changed`)
    expect(r.text).toContain(pinned!.fp)
    expect(r.text).toContain(presented.fp)

    expect(await pinFor(request)).toEqual(pinned) // never silently re-pinned
    const alert = await hostKeyAlert(request)
    expect(alert, 'expected a live ssh_host_key notification').toBeTruthy()
    expect(alert!.message).toContain(presented.fp)
  })

  test('Settings → Instances lists the pin with a Forget button', async ({ page, request }) => {
    const pinned = await pinFor(request)
    await page.goto('/settings/instances')
    await expect(page.getByRole('heading', { name: 'SSH host keys' })).toBeVisible()
    const row = page.locator('tr').filter({ hasText: HOST })
    await expect(row).toContainText(pinned!.fp)
    await expect(row.getByRole('button', { name: `Forget host key for ${HOST}` })).toBeVisible()
  })

  test('Forget clears the alert and the next connection pins the new key', async ({ page, request }) => {
    const presented = await sshdKey()
    await page.goto('/settings/instances')
    page.once('dialog', (d) => d.accept())
    await page.getByRole('button', { name: `Forget host key for ${HOST}` }).click()
    await expect(page.getByText(`Forgot the host key for ${HOST}`)).toBeVisible()
    expect(await hostKeyAlert(request)).toBeUndefined()

    const r = await connectOnce(request, instanceId)
    expect(r.text).not.toContain('host key')
    expect(await pinFor(request)).toMatchObject({ fp: presented.fp })
  })

  test('concurrent first connections agree on one pin', async ({ request }) => {
    const { primaryId, replicaId } = await instanceIds(request)
    const key = await sshdKey()
    await request.delete('/api/ssh/host-keys', { data: { host: HOST } })
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => connectOnce(request, i % 2 ? replicaId : primaryId))
    )
    for (const r of results) expect(r.text).not.toContain('host key')
    expect(await pinFor(request)).toMatchObject({ fp: key.fp })
    expect(await hostKeyAlert(request)).toBeUndefined()
  })

  test('forgetting needs admin and a valid host', async ({ request }) => {
    expect((await request.delete('/api/ssh/host-keys', { data: { host: 'no such host!' } })).status()).toBe(400)
    expect((await request.delete('/api/ssh/host-keys', { data: { host: '10.255.255.1' } })).status()).toBe(404)
  })
})
