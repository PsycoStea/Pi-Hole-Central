import { requireAdmin } from '@/lib/auth-guard'
import { db } from '@/lib/db'
import { instances } from '@/lib/db/schema'
import { eq, isNotNull } from 'drizzle-orm'
import { connectSSH, extractHost } from '@/lib/ssh/client'
import { applyForwardZone } from '@/lib/ssh/unbound'
import { invalidForwardAddrs, UPSTREAM_APPLY_DISABLED, UPSTREAM_APPLY_ENABLED } from '@/lib/unbound/presets'
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const denied = await requireAdmin()
  if (denied) return denied
  // See UPSTREAM_APPLY_DISABLED: unsafe on these nodes until rewritten.
  if (!UPSTREAM_APPLY_ENABLED) return NextResponse.json({ error: UPSTREAM_APPLY_DISABLED }, { status: 503 })

  const { addrs } = await req.json()
  if (!Array.isArray(addrs) || addrs.length === 0 || addrs.some((a) => typeof a !== 'string')) {
    return NextResponse.json({ error: 'addrs must be a non-empty string array' }, { status: 400 })
  }
  const invalid = invalidForwardAddrs(addrs)
  if (invalid.length > 0) {
    return NextResponse.json(
      { error: `Invalid forward address(es): ${invalid.join(', ')}. Expected IP[@port][#hostname].` },
      { status: 400 }
    )
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
        await applyForwardZone(ssh, addrs)
      } finally {
        ssh.dispose()
      }
    })
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
