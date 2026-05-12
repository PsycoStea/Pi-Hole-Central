import { auth } from '@/lib/auth'
import { requireAdmin } from '@/lib/auth-guard'
import { db } from '@/lib/db'
import { users } from '@/lib/db/schema'
import { eq, ne, and } from 'drizzle-orm'
import bcrypt from 'bcryptjs'
import { NextResponse } from 'next/server'

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = await requireAdmin()
  if (denied) return denied

  const { id } = await params
  const { role, password } = await req.json()

  if (role !== undefined) {
    if (!['admin', 'viewer'].includes(role)) {
      return NextResponse.json({ error: 'role must be admin or viewer' }, { status: 400 })
    }
    await db.update(users).set({ role }).where(eq(users.id, id))
  }

  if (password !== undefined) {
    if (typeof password !== 'string' || password.length < 8) {
      return NextResponse.json({ error: 'Password must be at least 8 characters' }, { status: 400 })
    }
    const hash = await bcrypt.hash(password, 12)
    await db.update(users).set({ passwordHash: hash }).where(eq(users.id, id))
  }

  return NextResponse.json({ ok: true })
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = await requireAdmin()
  if (denied) return denied

  const session = await auth()
  const { id } = await params

  if (id === session!.user!.id) {
    return NextResponse.json({ error: 'Cannot delete your own account' }, { status: 400 })
  }

  // Prevent deleting the last admin
  const target = await db.query.users.findFirst({ where: eq(users.id, id) })
  if (target?.role === 'admin') {
    const adminCount = await db.query.users.findMany({
      where: and(eq(users.role, 'admin'), ne(users.id, id)),
    })
    if (adminCount.length === 0) {
      return NextResponse.json({ error: 'Cannot delete the last admin account' }, { status: 400 })
    }
  }

  await db.delete(users).where(eq(users.id, id))
  return NextResponse.json({ ok: true })
}
