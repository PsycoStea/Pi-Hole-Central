import { requireAdmin } from '@/lib/auth-guard'
import { db } from '@/lib/db'
import { instances } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import * as piholeClient from '@/lib/pihole/client'
import { NextResponse } from 'next/server'
import { errMsg } from '@/lib/errors'
import { auditedNodeCall } from '@/lib/audit'
import { acquireNodeLock, busyMessage, getActiveNodeLock, releaseNodeLock } from '@/lib/ops/node-lock'

export const dynamic = 'force-dynamic'

export async function POST() {
  const denied = await requireAdmin()
  if (denied) return denied

  const activeInstances = await db.query.instances.findMany({
    where: eq(instances.enabled, true),
  })

  // Strictly one node after the other (triggerGravity also queues globally):
  // running both at once trips GitHub's per-IP rate limit on blocklist
  // downloads and leaves a node on stale cached lists.
  const results = await auditedNodeCall(
    'gravity.run_all',
    'all',
    '',
    async () => {
      const out: { id: string; name: string; ok: boolean; failedLists?: number; error?: string }[] = []
      for (const inst of activeInstances) {
        // A node busy with an update, recovery or backup is skipped, not waited for (P5.2).
        const lock = await acquireNodeLock(inst.id, 'gravity')
        if (!lock) {
          const held = await getActiveNodeLock(inst.id)
          out.push({ id: inst.id, name: inst.name, ok: false, error: held ? busyMessage(held.kind, inst.name) : `${inst.name} is busy` })
          continue
        }
        try {
          const { failedLists } = await piholeClient.triggerGravity(inst.id)
          out.push({ id: inst.id, name: inst.name, ok: true, failedLists })
        } catch (err) {
          out.push({ id: inst.id, name: inst.name, ok: false, error: errMsg(err) })
        } finally {
          await releaseNodeLock(lock)
        }
      }
      return out
    },
    (rs) => rs.map((r) => `${r.name}:${r.ok ? 'ok' : 'failed'}`).join(', ')
  )

  return NextResponse.json({ results })
}
