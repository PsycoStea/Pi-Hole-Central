import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { instances } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { globalSingleton } from '@/lib/global-state'
import { getLiveHistory } from '@/lib/pihole/history'
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

type Row = { timestamp: number; blocked: number; total: number }
// Cache plus the in-flight refresh (P5.8): concurrent misses share one
// refresh, so each node gets one /api/history call per miss, not one per request.
const state = globalSingleton('__statsBlocksCache', () => ({
  cache: null as { data: Row[]; ts: number } | null,
  inflight: null as Promise<Row[]> | null,
}))
const BLOCKS_TTL = 60_000

async function refresh(): Promise<Row[]> {
  const activeInstances = await db.query.instances.findMany({
    where: eq(instances.enabled, true),
  })

  const results = await Promise.allSettled(
    activeInstances.map((inst) => getLiveHistory(inst.id))
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

  state.cache = { data, ts: Date.now() }
  return data
}

export async function GET() {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  if (state.cache && Date.now() - state.cache.ts < BLOCKS_TTL) {
    return NextResponse.json({ data: state.cache.data })
  }

  if (!state.inflight) {
    state.inflight = refresh().finally(() => {
      state.inflight = null
    })
  }
  const data = await state.inflight
  return NextResponse.json({ data })
}
