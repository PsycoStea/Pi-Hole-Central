import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { instances } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import * as piholeClient from '@/lib/pihole/client'

export async function GET() {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const activeInstances = await db.query.instances.findMany({
    where: eq(instances.enabled, true),
  })

  const results = await Promise.allSettled(
    activeInstances.map(async (inst) => {
      const summary = await piholeClient.getSummary(inst.id)
      const blocking = await piholeClient.getBlockingStatus(inst.id)
      return { id: inst.id, name: inst.name, url: inst.url, status: 'online' as const, summary, blocking }
    })
  )

  const instanceData = results.map((r, i) => {
    if (r.status === 'fulfilled') return r.value
    return {
      id: activeInstances[i].id,
      name: activeInstances[i].name,
      url: activeInstances[i].url,
      status: 'offline' as const,
      summary: null,
      blocking: null,
    }
  })

  const online = instanceData.filter((i) => i.status === 'online' && i.summary)
  const aggregated = {
    totalQueries: online.reduce((s, i) => s + (i.summary?.queries.total ?? 0), 0),
    totalBlocked: online.reduce((s, i) => s + (i.summary?.queries.blocked ?? 0), 0),
    blockPct:
      online.length
        ? online.reduce((s, i) => s + (i.summary?.queries.percent_blocked ?? 0), 0) / online.length
        : 0,
    instancesOnline: online.length,
    instancesTotal: activeInstances.length,
  }

  return NextResponse.json({ instances: instanceData, aggregated })
}
