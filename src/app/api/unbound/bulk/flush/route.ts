import { requireAdmin } from '@/lib/auth-guard'
import { db } from '@/lib/db'
import { instances } from '@/lib/db/schema'
import { eq, isNotNull } from 'drizzle-orm'
import { connectSSH, extractHost } from '@/lib/ssh/client'
import { flushUnboundCache } from '@/lib/ssh/unbound'
import { NextResponse } from 'next/server'
import { logAudit } from '@/lib/audit'

export const dynamic = 'force-dynamic'

export async function POST() {
  const denied = await requireAdmin()
  if (denied) return denied

  const targets = await db.query.instances.findMany({
    where: (t, { and }) => and(eq(t.enabled, true), isNotNull(t.sshUsername)),
  })

  const results = await Promise.allSettled(
    targets.map(async (inst) => {
      const ssh = await connectSSH({
        host: extractHost(inst.url),
        username: inst.sshUsername!,
        passwordEncrypted: inst.sshPasswordEncrypted,
      })
      try {
        await flushUnboundCache(ssh)
      } finally {
        ssh.dispose()
      }
    })
  )

  await logAudit(
    'unbound.flush_all',
    'all',
    '' + targets.map((inst, i) => `${inst.name}:${results[i].status === 'fulfilled' ? 'ok' : 'failed'}`).join(', ')
  )

  return NextResponse.json({
    results: targets.map((inst, i) => ({
      id: inst.id,
      name: inst.name,
      ok: results[i].status === 'fulfilled',
      error: results[i].status === 'rejected' ? String((results[i] as PromiseRejectedResult).reason) : undefined,
    })),
  })
}
