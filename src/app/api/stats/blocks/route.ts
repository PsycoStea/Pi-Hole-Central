import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { instances } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import * as piholeClient from '@/lib/pihole/client'
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

let blocksCache: { data: unknown[]; ts: number } | null = null
const BLOCKS_TTL = 60_000

export async function GET() {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  if (blocksCache && Date.now() - blocksCache.ts < BLOCKS_TTL) {
    return NextResponse.json({ data: blocksCache.data })
  }

  const activeInstances = await db.query.instances.findMany({
    where: eq(instances.enabled, true),
  })

  const results = await Promise.allSettled(
    activeInstances.map((inst) => piholeClient.getQueryHistory(inst.id))
  )

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

  blocksCache = { data, ts: Date.now() }
  return NextResponse.json({ data })
}
