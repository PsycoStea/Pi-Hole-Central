import NextAuth from 'next-auth'
import Credentials from 'next-auth/providers/credentials'
import { db } from '@/lib/db'
import { users } from '@/lib/db/schema'
import { and, eq, sql } from 'drizzle-orm'
import { authConfig } from '../../auth.config'
import { logAudit } from '@/lib/audit'
import { globalSingleton } from '@/lib/global-state'
import { checkSession, notifySessionsEnded } from '@/lib/session-check'
import { checkPassword, clientIp } from '@/lib/login-gate'

// Failed sign-ins are audited, but each row costs the attacker nothing extra,
// so rows are capped: per account (or one bucket for unknown usernames) at most
// FAIL_ROWS_PER_WINDOW rows per window; the rest are counted and the count rides
// on the next row written. (The attempts themselves are throttled by
// login-gate.ts.)
const FAIL_WINDOW_MS = 10 * 60_000
const FAIL_ROWS_PER_WINDOW = 3
const failAudit = globalSingleton(
  '__piholeCentralSigninFailAudit',
  () => new Map<string, { windowStart: number; written: number; suppressed: number }>()
)

async function auditSigninFailure(bucket: string, target: string, detail: string, actor: { id: string; name: string }) {
  const now = Date.now()
  let st = failAudit.get(bucket)
  if (!st || now - st.windowStart >= FAIL_WINDOW_MS) {
    const carried = st?.suppressed ?? 0
    st = { windowStart: now, written: 0, suppressed: 0 }
    failAudit.set(bucket, st)
    if (carried) detail += ` (+${carried} earlier failure(s) not recorded individually)`
  }
  if (st.written >= FAIL_ROWS_PER_WINDOW) {
    st.suppressed++
    if (st.suppressed === 1) console.warn(`[auth] repeated failed sign-ins (${actor.name}); further rows this window are counted, not written`)
    return
  }
  st.written++
  await logAudit('auth.signin_failed', target, detail, actor)
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      credentials: {
        username: { label: 'Username', type: 'text' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials, request) {
        // Usernames are stored trimmed (P3.5), so trim what was typed too.
        const username = typeof credentials?.username === 'string' ? credentials.username.trim() : ''
        const password = credentials?.password
        if (!username || typeof password !== 'string' || !password) return null
        const user = await db.query.users.findFirst({
          where: eq(users.username, username),
        })
        // Every check goes through the gate (R2-F1); an unknown username is
        // compared against a dummy hash so it costs and looks like a wrong
        // password.
        const result = await checkPassword(password, user?.passwordHash ?? null, username.toLowerCase(), clientIp(request))
        if (!result.ok) {
          const detail =
            result.reason === 'ip_limited' ? 'refused: too many failed sign-ins from this address' :
            result.reason === 'busy' ? 'refused: too many sign-ins in progress' :
            user ? 'wrong password' : 'unknown username'
          // The typed username is recorded only when it is a real account: an
          // unknown one may be a password typed into the wrong field.
          if (user) await auditSigninFailure(`user:${user.id}`, user.id, detail, { id: user.id, name: user.username })
          else await auditSigninFailure('unknown', '', detail, { id: '', name: '(unknown)' })
          return null
        }
        if (!user) return null // unreachable: a dummy hash never matches
        await logAudit('auth.signin', user.id, '', { id: user.id, name: user.username })
        return {
          id: user.id,
          name: user.username,
          role: user.role as 'admin' | 'viewer',
          tokenVersion: user.tokenVersion,
        }
      },
    }),
  ],
  callbacks: {
    ...authConfig.callbacks,
    // Runs on sign-in (with `user`) and on every later auth() / session read.
    // Re-reading the row each time makes a demotion, deletion or revocation take
    // effect on the user's next request instead of when their 30-day token
    // expires. src/proxy.ts runs this full auth on the Node runtime, and every
    // API route and the dashboard layout call auth(), so all of them see it.
    //
    // Revocation (R1-F1): the token carries users.token_version from sign-in
    // (`tv`). Password change, admin reset, demotion and sign-out bump the
    // column, which ends every session the user has. Tokens minted before
    // migration 0010 have no `tv` and are refused.
    //
    // There is deliberately no `trigger === 'update'` branch that refreshes
    // `tv`: the client can trigger an update, so a stolen token could
    // re-validate itself. Changing your own password signs you out too.
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id
        token.role = (user as { role: 'admin' | 'viewer' }).role
        token.tv = (user as { tokenVersion: number }).tokenVersion
        return token
      }
      if (!token.id) return token
      const check = await checkSession(token.id as string, token.tv)
      if (check.status === 'deleted' || check.status === 'revoked') return null // end the session
      if (check.status === 'ok') token.role = check.role
      // 'error': keep the token and its role (fail open, see session-check.ts).
      else console.error('[auth] session refresh failed, keeping token role:', check.error)
      return token
    },
    session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string
        session.user.role = (token.role ?? 'viewer') as 'admin' | 'viewer'
        // The SSE stream re-checks against this (P3.2). A counter, not a secret.
        session.user.tv = typeof token.tv === 'number' ? token.tv : undefined
      }
      return session
    },
  },
  events: {
    // Sign-out ends every session of this user, not just this browser: a
    // stateless JWT cannot be revoked one at a time. Only a still-valid token
    // bumps the version, so a token that was already revoked cannot be used to
    // keep signing the owner out.
    async signOut(message) {
      const token = 'token' in message ? message.token : null
      const id = token?.id
      const tv = token?.tv
      if (typeof id !== 'string' || typeof tv !== 'number') return
      const r = db.update(users)
        .set({ tokenVersion: sql`${users.tokenVersion} + 1` })
        .where(and(eq(users.id, id), eq(users.tokenVersion, tv)))
        .run()
      if (r.changes > 0) notifySessionsEnded(id)
    },
  },
})
