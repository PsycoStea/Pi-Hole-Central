import { fetchInstanceSummary, aggregate } from '@/lib/pihole/summary'
import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { instances } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'

export async function GET() {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const activeInstances = await db.query.instances.findMany({
    where: eq(instances.enabled, true),
  })

  const instanceData = await Promise.all(activeInstances.map(fetchInstanceSummary))
  const aggregated = aggregate(instanceData, activeInstances.length)

  return NextResponse.json({ instances: instanceData, aggregated })
}
