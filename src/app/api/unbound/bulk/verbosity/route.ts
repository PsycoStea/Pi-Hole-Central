import { requireAdmin } from '@/lib/auth-guard'
import { db } from '@/lib/db'
import { instances } from '@/lib/db/schema'
import { eq, isNotNull } from 'drizzle-orm'
import { connectSSH, extractHost } from '@/lib/ssh/client'
import { setUnboundVerbosity } from '@/lib/ssh/unbound'
import { NextResponse } from 'next/server'
import { logAudit } from '@/lib/audit'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const denied = await requireAdmin()
  if (denied) return denied

  const { level } = await req.json()
  if (typeof level !== 'number' || !Number.isInteger(level) || level < 0 || level > 5) {
    return NextResponse.json({ error: 'level must be an integer 0–5' }, { status: 400 })
  }

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
        await setUnboundVerbosity(ssh, level)
      } finally {
        ssh.dispose()
      }
    })
  )

  await logAudit(
    'unbound.verbosity_all',
    'all',
    `level=${level} ` + targets.map((inst, i) => `${inst.name}:${results[i].status === 'fulfilled' ? 'ok' : 'failed'}`).join(', ')
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
