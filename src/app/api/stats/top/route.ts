import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { instances, statsSnapshots } from '@/lib/db/schema'
import { eq, max, inArray, and } from 'drizzle-orm'
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

let cache: { topDomains: unknown[]; topClients: unknown[]; ts: number } | null = null
const CACHE_TTL = 60_000

export async function GET() {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  if (cache && Date.now() - cache.ts < CACHE_TTL) {
    return NextResponse.json({ topDomains: cache.topDomains, topClients: cache.topClients })
  }

  const activeInstances = await db.query.instances.findMany({
    where: eq(instances.enabled, true),
  })

  const domainCounts = new Map<string, number>()
  const clientCounts = new Map<string, { ip: string; name: string; count: number }>()

  if (activeInstances.length > 0) {
    const instanceIds = activeInstances.map(i => i.id)

    // Single query: latest snapshot per instance via subquery join (replaces N+1 loop)
    const subquery = db
      .select({
        instanceId: statsSnapshots.instanceId,
        maxTs: max(statsSnapshots.timestamp).as('max_ts'),
      })
      .from(statsSnapshots)
      .where(inArray(statsSnapshots.instanceId, instanceIds))
      .groupBy(statsSnapshots.instanceId)
      .as('latest')

    const latestSnapshots = await db
      .select({ snap: statsSnapshots })
      .from(statsSnapshots)
      .innerJoin(
        subquery,
        and(
          eq(statsSnapshots.instanceId, subquery.instanceId),
          eq(statsSnapshots.timestamp, subquery.maxTs)
        )
      )

    for (const { snap } of latestSnapshots) {
      const domains: { domain: string; count: number }[] = JSON.parse(snap.topDomainsJson)
      for (const d of domains) {
        domainCounts.set(d.domain, (domainCounts.get(d.domain) ?? 0) + d.count)
      }
      const clients: { ip: string; name: string; count: number }[] = JSON.parse(snap.topClientsJson)
      for (const c of clients) {
        const existing = clientCounts.get(c.ip)
        clientCounts.set(c.ip, { ip: c.ip, name: c.name, count: (existing?.count ?? 0) + c.count })
      }
    }
  }

  const topDomains = Array.from(domainCounts.entries())
    .map(([domain, count]) => ({ domain, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)

  const topClients = Array.from(clientCounts.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)

  cache = { topDomains, topClients, ts: Date.now() }
  return NextResponse.json({ topDomains, topClients })
}
