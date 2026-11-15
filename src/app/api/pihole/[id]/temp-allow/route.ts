import { enabledInstance } from '@/lib/pihole/instance-guard'
import { auditedNodeCall } from '@/lib/audit'
import { NextResponse } from 'next/server'
import { isDomainEntry } from '@/lib/pihole/validate'
import { auth } from '@/lib/auth'
import { requireAdmin } from '@/lib/auth-guard'
import { withApiError } from '@/lib/api/with-error'
import { db } from '@/lib/db'
import { tempAllows } from '@/lib/db/schema'
import { and, eq, desc } from 'drizzle-orm'
import * as piholeClient from '@/lib/pihole/client'
import { randomUUID } from 'crypto'

export const dynamic = 'force-dynamic'

export const GET = withApiError(
  async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const session = await auth()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const { id } = await params
    // R2-NV2: a disabled node gets no calls, not even reads.
    const guard = await enabledInstance(id)
    if (guard.denied) return guard.denied
    const rows = await db.query.tempAllows.findMany({
      where: and(eq(tempAllows.instanceId, id), eq(tempAllows.reverted, false)),
      orderBy: desc(tempAllows.expiresAt),
    })
    return NextResponse.json({ tempAllows: rows })
  }
)

export const POST = withApiError(
  async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const denied = await requireAdmin()
    if (denied) return denied
    const { id } = await params
    const { domain, kind = 'exact', list = 'allow', durationMinutes } = await req.json()
    if (!isDomainEntry(domain)) {
      return NextResponse.json({ error: 'domain is required (no spaces, not "." or "..")' }, { status: 400 })
    }
    if (list !== 'allow' && list !== 'deny') {
      return NextResponse.json({ error: 'list must be allow|deny' }, { status: 400 })
    }
    if (kind !== 'exact' && kind !== 'regex') {
      return NextResponse.json({ error: 'kind must be exact|regex' }, { status: 400 })
    }
    const mins = Number(durationMinutes)
    if (!Number.isFinite(mins) || mins < 1 || mins > 1440) {
      return NextResponse.json({ error: 'durationMinutes must be 1-1440' }, { status: 400 })
    }

    // Refuse if the entry already exists. The revert at expiry DELETEs the
    // domain, so a "temporary" allow of something already permanently allowed
    // used to remove the permanent entry when it expired.
    const existing = await piholeClient.getDomains(id, list)
    if (existing.some((d) => d.domain === domain && d.kind === kind)) {
      return NextResponse.json(
        { error: `${domain} is already on the ${list}list (${kind}); a temporary entry would remove it on expiry` },
        { status: 409 }
      )
    }

    // Record the expiry FIRST, then add to Pi-hole, so an entry that reached
    // the node always has a row the scheduler will revert. If the add fails,
    // drop the row again.
    const rowId = randomUUID()
    const now = Date.now()
    await db.insert(tempAllows).values({
      id: rowId,
      instanceId: id,
      domain,
      kind,
      list,
      createdAt: new Date(now),
      expiresAt: new Date(now + mins * 60_000),
      reverted: false,
    })
    try {
      await auditedNodeCall('temp_allow.add', id, `${list}/${kind}: ${domain} for ${mins}m`, () =>
        piholeClient.addDomain(id, domain, list, kind, `temporary (${mins}m) via pihole-central`)
      )
    } catch (err) {
      // A timeout or error does not mean the node did not add it. Drop the
      // row only when the node confirms the entry is absent; otherwise keep
      // it, so the expiry revert still removes whatever did land (a dropped
      // row left an applied entry on the node with no expiry at all).
      let absent = false
      try {
        absent = await piholeClient.isDomainGone(id, list, kind, domain)
      } catch {
        /* node unreachable: keep the row, the revert retries every minute */
      }
      if (absent) await db.delete(tempAllows).where(eq(tempAllows.id, rowId))
      throw err
    }
    return NextResponse.json({ ok: true }, { status: 201 })
  }
)

// Revert a temporary entry early.
export const DELETE = withApiError(
  async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const denied = await requireAdmin()
    if (denied) return denied
    const { id: instanceId } = await params
    const { id } = await req.json()
    if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })
    // Scope to the instance in the URL: looking up by row id alone removed the
    // domain from whichever node the URL named, even if the row was another's.
    const row = await db.query.tempAllows.findFirst({
      where: and(eq(tempAllows.id, id), eq(tempAllows.instanceId, instanceId)),
    })
    if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    await auditedNodeCall(
      'temp_allow.revert',
      instanceId,
      `${row.list}/${row.kind}: ${row.domain}`,
      async () => {
        let note = ''
        try {
          await piholeClient.removeDomain(instanceId, row.list as 'allow' | 'deny', row.kind, row.domain)
        } catch (err) {
          if (!piholeClient.isNotFound(err)) throw err
          note = 'already gone' // fine
        }
        // Only an entry the node no longer lists counts as reverted (R2-F6).
        if (!(await piholeClient.isDomainGone(instanceId, row.list as 'allow' | 'deny', row.kind, row.domain))) {
          throw new Error('the entry is still on the node after removal')
        }
        return note
      },
      (r) => r
    )
    await db.update(tempAllows).set({ reverted: true }).where(eq(tempAllows.id, id))
    return NextResponse.json({ ok: true })
  }
)
