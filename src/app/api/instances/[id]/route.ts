import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { instances } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { encrypt } from '@/lib/crypto'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params
  const instance = await db.query.instances.findFirst({ where: eq(instances.id, id) })
  if (!instance) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const { passwordEncrypted: _, ...safe } = instance
  return NextResponse.json(safe)
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params
  const body = await req.json()
  const update: Partial<typeof instances.$inferInsert> = {}
  if (body.name) update.name = body.name
  if (body.url) update.url = body.url.replace(/\/$/, '')
  if (body.password) update.passwordEncrypted = encrypt(body.password)
  if (typeof body.enabled === 'boolean') update.enabled = body.enabled
  await db.update(instances).set(update).where(eq(instances.id, id))
  return NextResponse.json({ ok: true })
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params
  await db.delete(instances).where(eq(instances.id, id))
  return NextResponse.json({ ok: true })
}
