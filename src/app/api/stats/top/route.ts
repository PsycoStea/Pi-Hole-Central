import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { instances, statsSnapshots } from '@/lib/db/schema'
import { eq, desc } from 'drizzle-orm'
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function GET() {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const activeInstances = await db.query.instances.findMany({
    where: eq(instances.enabled, true),
  })

  const domainCounts = new Map<string, number>()
  const clientCounts = new Map<string, { ip: string; name: string; count: number }>()

  for (const inst of activeInstances) {
    const latest = await db.query.statsSnapshots.findFirst({
      where: eq(statsSnapshots.instanceId, inst.id),
      orderBy: desc(statsSnapshots.timestamp),
    })
    if (!latest) continue

    const domains: { domain: string; count: number }[] = JSON.parse(latest.topDomainsJson)
    for (const d of domains) {
      domainCounts.set(d.domain, (domainCounts.get(d.domain) ?? 0) + d.count)
    }

    const clients: { ip: string; name: string; count: number }[] = JSON.parse(latest.topClientsJson)
    for (const c of clients) {
      const existing = clientCounts.get(c.ip)
      clientCounts.set(c.ip, {
        ip: c.ip,
        name: c.name,
        count: (existing?.count ?? 0) + c.count,
      })
    }
  }

  const topDomains = Array.from(domainCounts.entries())
    .map(([domain, count]) => ({ domain, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)

  const topClients = Array.from(clientCounts.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)

  return NextResponse.json({ topDomains, topClients })
}
