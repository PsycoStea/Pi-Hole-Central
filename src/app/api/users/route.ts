import { auth } from '@/lib/auth'
import { requireAdmin } from '@/lib/auth-guard'
import { db } from '@/lib/db'
import { users } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import bcrypt from 'bcryptjs'
import { randomUUID } from 'crypto'
import { NextResponse } from 'next/server'

export async function GET() {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const denied = await requireAdmin()
  if (denied) return denied

  const allUsers = await db.query.users.findMany()
  return NextResponse.json({
    users: allUsers.map((u) => ({
      id: u.id,
      username: u.username,
      role: u.role,
      createdAt: u.createdAt,
    })),
  })
}

export async function POST(req: Request) {
  const denied = await requireAdmin()
  if (denied) return denied

  const { username, password, role = 'viewer' } = await req.json()

  if (!username || !password) {
    return NextResponse.json({ error: 'username and password are required' }, { status: 400 })
  }
  if (!['admin', 'viewer'].includes(role)) {
    return NextResponse.json({ error: 'role must be admin or viewer' }, { status: 400 })
  }
  if (typeof password !== 'string' || password.length < 8) {
    return NextResponse.json({ error: 'Password must be at least 8 characters' }, { status: 400 })
  }

  try {
    const existing = await db.query.users.findFirst({ where: eq(users.username, username) })
    if (existing) return NextResponse.json({ error: 'Username already taken' }, { status: 409 })

    const hash = await bcrypt.hash(password, 12)
    const id = randomUUID()
    await db.insert(users).values({ id, username, passwordHash: hash, role, createdAt: new Date() })

    return NextResponse.json({ id, username, role }, { status: 201 })
  } catch (err) {
    console.error('[POST /api/users]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
