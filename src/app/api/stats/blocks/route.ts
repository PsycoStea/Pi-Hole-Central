import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { instances } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import * as piholeClient from '@/lib/pihole/client'
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function GET() {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const to = Math.floor(Date.now() / 1000)
  const from = to - 86400

  const activeInstances = await db.query.instances.findMany({
    where: eq(instances.enabled, true),
  })

  const results = await Promise.allSettled(
    activeInstances.map((inst) => piholeClient.getQueryHistory(inst.id, from, to))
  )

  // Aggregate by 10-min timestamp bucket across all instances
  const buckets = new Map<number, { blocked: number; total: number }>()
  for (const result of results) {
    if (result.status !== 'fulfilled') continue
    for (const row of result.value) {
      const existing = buckets.get(row.timestamp) ?? { blocked: 0, total: 0 }
      buckets.set(row.timestamp, {
        blocked: existing.blocked + row.blocked,
        total: existing.total + row.total,
      })
    }
  }

  const data = Array.from(buckets.entries())
    .map(([timestamp, v]) => ({ timestamp, ...v }))
    .sort((a, b) => a.timestamp - b.timestamp)

  return NextResponse.json({ data })
}
