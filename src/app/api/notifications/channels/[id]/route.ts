import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { notificationChannels } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { encrypt } from '@/lib/crypto'

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params
  const body = await req.json()
  const update: Partial<typeof notificationChannels.$inferInsert> = {}
  if (body.label) update.label = body.label
  if (body.config) update.configJson = encrypt(JSON.stringify(body.config))
  if (typeof body.enabled === 'boolean') update.enabled = body.enabled
  await db.update(notificationChannels).set(update).where(eq(notificationChannels.id, id))
  return NextResponse.json({ ok: true })
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params
  await db.delete(notificationChannels).where(eq(notificationChannels.id, id))
  return NextResponse.json({ ok: true })
}
