import { auth } from '@/lib/auth'
import { requireAdmin } from '@/lib/auth-guard'
import { db } from '@/lib/db'
import { users } from '@/lib/db/schema'
import { eq, ne, and, sql } from 'drizzle-orm'
import { hashPassword } from '@/lib/bcrypt-worker'
import { NextResponse } from 'next/server'
import { logAudit } from '@/lib/audit'
import { notifySessionsEnded } from '@/lib/session-check'
import { newPasswordProblem } from '@/lib/credentials'

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = await requireAdmin()
  if (denied) return denied

  const { id } = await params
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Request body must be a JSON object' }, { status: 400 })
  }
  const { role, password } = body

  // Validate everything before writing anything (R1-F6: the role used to be
  // committed before the password was checked, then 400 with no audit row).
  if (password !== undefined) {
    const pwProblem = newPasswordProblem(password)
    if (pwProblem) return NextResponse.json({ error: pwProblem }, { status: 400 })
    // Your own password changes on the Account page, which asks for the
    // current one; resetting it here would skip that check (and sign you out
    // with no explanation).
    const session = await auth()
    if (id === session?.user?.id) {
      return NextResponse.json(
        { error: 'Change your own password on the Account page' },
        { status: 400 },
      )
    }
  }

  if (role !== undefined) {
    if (!['admin', 'viewer'].includes(role)) {
      return NextResponse.json({ error: 'role must be admin or viewer' }, { status: 400 })
    }
    // Prevent demoting the last remaining admin (would lock everyone out of
    // admin functions, recoverable only via direct DB edit). DELETE guards this
    // already; PATCH must too.
    if (role === 'viewer') {
      // The UI already hides this; enforce it so a stale tab can't do it either.
      const session = await auth()
      if (id === session?.user?.id) {
        return NextResponse.json({ error: 'You cannot change your own role' }, { status: 400 })
      }
      const target = await db.query.users.findFirst({ where: eq(users.id, id) })
      if (target?.role === 'admin') {
        const otherAdmins = await db.query.users.findMany({
          where: and(eq(users.role, 'admin'), ne(users.id, id)),
        })
        if (otherAdmins.length === 0) {
          return NextResponse.json(
            { error: 'Cannot demote the last admin account' },
            { status: 400 }
          )
        }
      }
    }
  }

  const set: {
    role?: 'admin' | 'viewer'
    passwordHash?: string
    tokenVersion?: ReturnType<typeof sql>
  } = {}
  if (role !== undefined) set.role = role
  if (password !== undefined) set.passwordHash = await hashPassword(password, 12)
  // A password reset or a demotion ends the user's existing sessions (R1-F1).
  if (password !== undefined || role === 'viewer') {
    set.tokenVersion = sql`${users.tokenVersion} + 1`
  }
  if (Object.keys(set).length > 0) {
    // One statement, so role, password and revocation land together or not at all.
    db.update(users).set(set).where(eq(users.id, id)).run()
  }
  if (set.tokenVersion) notifySessionsEnded(id) // close their open SSE streams now

  await logAudit('user.update', id, [role !== undefined ? `role=${role}` : '', password !== undefined ? 'password' : ''].filter(Boolean).join(', '))
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
  notifySessionsEnded(id)
  await logAudit('user.remove', id, target?.username ?? '')
  return NextResponse.json({ ok: true })
}
