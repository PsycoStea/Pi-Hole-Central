import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { recoveryEvents } from '@/lib/db/schema'
import { eq, desc } from 'drizzle-orm'

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params

  const events = await db.query.recoveryEvents.findMany({
    where: eq(recoveryEvents.instanceId, id),
    orderBy: desc(recoveryEvents.timestamp),
    limit: 100,
  })

  return NextResponse.json({ events })
}
