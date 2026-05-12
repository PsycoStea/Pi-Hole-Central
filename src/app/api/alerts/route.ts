import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { requireAdmin } from '@/lib/auth-guard'
import { db } from '@/lib/db'
import { alertSettings } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'

export async function GET() {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const settings = await db.query.alertSettings.findMany()
  return NextResponse.json(settings)
}

export async function PUT(req: Request) {
  const denied = await requireAdmin()
  if (denied) return denied
  const { id, enabled, threshold, channelIds } = await req.json()
  const update: Partial<typeof alertSettings.$inferInsert> = {}
  if (typeof enabled === 'boolean') update.enabled = enabled
  if (threshold !== undefined) update.threshold = threshold
  if (channelIds !== undefined) update.channelIdsJson = JSON.stringify(channelIds)
  await db.update(alertSettings).set(update).where(eq(alertSettings.id, id))
  return NextResponse.json({ ok: true })
}
