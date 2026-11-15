import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth-guard'
import { withApiError } from '@/lib/api/with-error'
import { auditedNodeCall } from '@/lib/audit'
import * as piholeClient from '@/lib/pihole/client'
import { db } from '@/lib/db'
import { instances } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { acquireNodeLock, busyMessage, getActiveNodeLock, releaseNodeLock } from '@/lib/ops/node-lock'

export const POST = withApiError(
  async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const denied = await requireAdmin()
    if (denied) return denied
    const { id } = await params
    const inst = await db.query.instances.findFirst({ where: eq(instances.id, id) })
    if (!inst) return NextResponse.json({ error: 'Instance not found' }, { status: 404 })
    // Not during an update, recovery or backup of this node (P5.2).
    const lock = await acquireNodeLock(id, 'gravity')
    if (!lock) {
      const held = await getActiveNodeLock(id)
      return NextResponse.json({ error: held ? busyMessage(held.kind, inst.name) : `${inst.name} is busy; try again shortly.` }, { status: 409 })
    }
    let failedLists: number | undefined
    try {
      ;({ failedLists } = await auditedNodeCall('gravity.run', id, '', () => piholeClient.triggerGravity(id), (r) =>
        r.failedLists ? `${r.failedLists} list download(s) failed` : ''
      ))
    } finally {
      await releaseNodeLock(lock)
    }
    return NextResponse.json({
      ok: true,
      failedLists,
      message: failedLists
        ? `Gravity updated, but ${failedLists} list download(s) failed (cached copies used)`
        : 'Gravity updated',
    })
  }
)
