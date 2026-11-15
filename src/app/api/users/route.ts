import { auth } from '@/lib/auth'
import { requireAdmin } from '@/lib/auth-guard'
import { db } from '@/lib/db'
import { users } from '@/lib/db/schema'
import { sql } from 'drizzle-orm'
import { hashPassword } from '@/lib/bcrypt-worker'
import { newPasswordProblem, normalizeUsername } from '@/lib/credentials'
import { randomUUID } from 'crypto'
import { NextResponse } from 'next/server'
import { logAudit } from '@/lib/audit'

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

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Request body must be a JSON object' }, { status: 400 })
  }
  const { password, role = 'viewer' } = body
  const username = normalizeUsername(body.username)

  if (!username || !password) {
    return NextResponse.json({ error: 'username (1-64 characters) and password are required' }, { status: 400 })
  }
  if (!['admin', 'viewer'].includes(role)) {
    return NextResponse.json({ error: 'role must be admin or viewer' }, { status: 400 })
  }
  const pwProblem = newPasswordProblem(password)
  if (pwProblem) return NextResponse.json({ error: pwProblem }, { status: 400 })

  try {
    // Unique regardless of case, so "Admin" cannot sit beside "admin" in the
    // audit log and the users list.
    const existing = await db.query.users.findFirst({
      where: sql`lower(${users.username}) = ${username.toLowerCase()}`,
    })
    if (existing) return NextResponse.json({ error: 'Username already taken' }, { status: 409 })

    const hash = await hashPassword(password, 12)
    const id = randomUUID()
    await db.insert(users).values({ id, username, passwordHash: hash, role, createdAt: new Date() })
    await logAudit('user.add', id, `${username} (${role})`)

    return NextResponse.json({ id, username, role }, { status: 201 })
  } catch (err) {
    console.error('[POST /api/users]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
