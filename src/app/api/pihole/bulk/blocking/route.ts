import { requireAdmin } from '@/lib/auth-guard'
import { db } from '@/lib/db'
import { instances } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import * as piholeClient from '@/lib/pihole/client'
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const denied = await requireAdmin()
  if (denied) return denied

  const { enabled } = await req.json()
  if (typeof enabled !== 'boolean') {
    return NextResponse.json({ error: 'enabled must be a boolean' }, { status: 400 })
  }

  const activeInstances = await db.query.instances.findMany({
    where: eq(instances.enabled, true),
  })

  const results = await Promise.allSettled(
    activeInstances.map((inst) => piholeClient.setBlocking(inst.id, enabled))
  )

  return NextResponse.json({
    results: activeInstances.map((inst, i) => ({
      id: inst.id,
      name: inst.name,
      ok: results[i].status === 'fulfilled',
      error: results[i].status === 'rejected' ? String((results[i] as PromiseRejectedResult).reason) : undefined,
    })),
  })
}
