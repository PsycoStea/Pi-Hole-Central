import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { users } from '@/lib/db/schema'
import { eq, sql } from 'drizzle-orm'
import { hashPassword } from '@/lib/bcrypt-worker'
import { NextResponse } from 'next/server'
import { logAudit } from '@/lib/audit'
import { notifySessionsEnded } from '@/lib/session-check'
import { checkPassword, clientIp } from '@/lib/login-gate'
import { newPasswordProblem } from '@/lib/credentials'

export async function PATCH(req: Request) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => null)
  const { currentPassword, newPassword } = body && typeof body === 'object' ? body : ({} as Record<string, unknown>)

  if (typeof currentPassword !== 'string' || !currentPassword || !newPassword) {
    return NextResponse.json({ error: 'currentPassword and newPassword are required' }, { status: 400 })
  }
  const pwProblem = newPasswordProblem(newPassword)
  if (pwProblem) return NextResponse.json({ error: `New ${pwProblem.charAt(0).toLowerCase()}${pwProblem.slice(1)}` }, { status: 400 })

  const user = await db.query.users.findFirst({ where: eq(users.id, session.user.id) })
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  // Same gate as sign-in (R2-F1): a stolen session must not get unthrottled
  // guesses at the current password, or a way to burn the event loop.
  const result = await checkPassword(currentPassword, user.passwordHash, user.username.toLowerCase(), clientIp(req))
  if (!result.ok) {
    if (result.reason !== 'wrong') {
      await logAudit('user.password_change_failed', session.user.id, `refused: ${result.reason === 'busy' ? 'too many password checks in progress' : 'too many failures from this address'}`)
      return NextResponse.json({ error: 'Too many attempts, try again later' }, { status: 429 })
    }
    await logAudit('user.password_change_failed', session.user.id, 'current password incorrect')
    return NextResponse.json({ error: 'Current password is incorrect' }, { status: 401 })
  }

  const hash = await hashPassword(newPassword, 12)
  // Bumping token_version in the same statement ends every session this user
  // has, including the one making this request (R1-F1): a copied cookie must not
  // outlive the password. The client sends the user to the sign-in page.
  await db
    .update(users)
    .set({ passwordHash: hash, tokenVersion: sql`${users.tokenVersion} + 1` })
    .where(eq(users.id, session.user.id))
  notifySessionsEnded(session.user.id)
  await logAudit('user.password_change', session.user.id, user.username)

  return NextResponse.json({ ok: true, signedOut: true })
}
