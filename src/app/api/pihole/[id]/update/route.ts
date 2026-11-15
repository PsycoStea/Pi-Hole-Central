import { errMsg } from '@/lib/errors'
import { logAudit } from '@/lib/audit'
import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth-guard'
import { withApiError } from '@/lib/api/with-error'
import { db } from '@/lib/db'
import { instances, recoveryEvents } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { connectSSH, extractHost, runUpdate } from '@/lib/ssh/client'
import { acquireNodeLock, busyMessage, getActiveNodeLock, releaseNodeLock } from '@/lib/ops/node-lock'

export const POST = withApiError(
  async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const denied = await requireAdmin()
    if (denied) return denied

    const { id } = await params
    const instance = await db.query.instances.findFirst({ where: eq(instances.id, id) })
    if (!instance) return NextResponse.json({ error: 'Instance not found' }, { status: 404 })
    if (!instance.sshUsername) {
      return NextResponse.json({ error: 'SSH not configured for this instance' }, { status: 400 })
    }

    // One update at a time per node, and never during recovery, gravity or a
    // backup (P5.2 / R2-NV3). Taken here, before answering, so two quick
    // POSTs cannot both start `pihole -up`; released when the update ends.
    // While it is held, recovery and the watchdog leave the node alone.
    const lock = await acquireNodeLock(id, 'update')
    if (!lock) {
      const held = await getActiveNodeLock(id)
      return NextResponse.json(
        { error: held ? busyMessage(held.kind, instance.name) : `${instance.name} is busy; try again shortly.` },
        { status: 409 }
      )
    }

    // Fire and forget — pihole -up takes 2-5 minutes — but record the real
    // outcome to recovery_events so the user learns whether it actually ran
    // (it previously always reported success even when the command failed).
    connectSSH({
      host: extractHost(instance.url),
      username: instance.sshUsername,
      passwordEncrypted: instance.sshPasswordEncrypted,
    }, { execTimeoutMs: 15 * 60_000 }) // pihole -up takes minutes on a Pi Zero
      .then(async (ssh) => {
        console.log(`[update] Starting pihole -up on ${instance.name}`)
        try {
          const { code, stderr } = await runUpdate(ssh)
          const success = code === 0
          if (!success) {
            console.error(`[update] pihole -up failed for ${instance.name} (exit ${code}): ${stderr}`)
          }
          await db.insert(recoveryEvents).values({
            instanceId: id,
            timestamp: new Date(),
            eventType: 'pihole_update',
            detail: success
              ? 'pihole -up completed successfully'
              : `pihole -up failed (exit ${code})${stderr ? `: ${stderr.slice(0, 200)}` : ''}`,
            success,
          })
        } finally {
          ssh.dispose()
          await releaseNodeLock(lock)
        }
      })
      .catch(async (err) => {
        console.error(`[update] SSH connect failed for ${instance.name}: ${errMsg(err)}`)
        await db
          .insert(recoveryEvents)
          .values({
            instanceId: id,
            timestamp: new Date(),
            eventType: 'pihole_update',
            detail: `Update could not start — SSH connect failed: ${(err as Error).message}`,
            success: false,
          })
          .catch(() => {})
        await releaseNodeLock(lock)
      })

    // Audit now, inside the request (logAudit reads the session); the outcome
    // lands in recovery_events when pihole -up finishes.
    await logAudit('pihole.update', id, instance.name)
    return NextResponse.json({ started: true })
  }
)
