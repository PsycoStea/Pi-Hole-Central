import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { users } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import bcrypt from 'bcryptjs'
import { NextResponse } from 'next/server'

export async function PATCH(req: Request) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { currentPassword, newPassword } = await req.json()

  if (!currentPassword || !newPassword) {
    return NextResponse.json({ error: 'currentPassword and newPassword are required' }, { status: 400 })
  }
  if (typeof newPassword !== 'string' || newPassword.length < 8) {
    return NextResponse.json({ error: 'New password must be at least 8 characters' }, { status: 400 })
  }

  const user = await db.query.users.findFirst({ where: eq(users.id, session.user.id) })
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  const valid = await bcrypt.compare(currentPassword, user.passwordHash)
  if (!valid) return NextResponse.json({ error: 'Current password is incorrect' }, { status: 401 })

  const hash = await bcrypt.hash(newPassword, 12)
  await db.update(users).set({ passwordHash: hash }).where(eq(users.id, session.user.id))

  return NextResponse.json({ ok: true })
}
