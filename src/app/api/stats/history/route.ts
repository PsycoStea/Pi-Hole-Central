import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { statsSnapshots } from '@/lib/db/schema'
import { eq, gte, and } from 'drizzle-orm'

export async function GET(req: Request) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const url = new URL(req.url)
  const instanceId = url.searchParams.get('instanceId')
  const hours = parseInt(url.searchParams.get('hours') ?? '24')

  const since = new Date(Date.now() - hours * 60 * 60 * 1000)

  const conditions = instanceId
    ? and(eq(statsSnapshots.instanceId, instanceId), gte(statsSnapshots.timestamp, since))
    : gte(statsSnapshots.timestamp, since)

  const rows = await db.query.statsSnapshots.findMany({
    where: conditions,
    orderBy: (t, { asc }) => [asc(t.timestamp)],
    columns: {
      id: false,
      topDomainsJson: false,
      topClientsJson: false,
    },
  })

  return NextResponse.json(rows)
}
