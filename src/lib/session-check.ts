import { EventEmitter } from 'node:events'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { users } from '@/lib/db/schema'
import { globalSingleton } from '@/lib/global-state'

/**
 * Is a session for user `id`, minted with token_version `tv`, still valid?
 * Shared by the jwt callback (every auth() call, including proxy.ts) and the
 * long-lived SSE stream, which re-checks on a timer (audit R1-F1, R1-F2).
 *
 * - 'deleted' / 'revoked': end the session.
 * - 'error': the DB read failed. Callers keep the session (fail open): the DB
 *   is a local SQLite file an attacker cannot make fail on demand, and a hiccup
 *   must not sign everyone out.
 */
export type SessionCheck =
  | { status: 'ok'; role: 'admin' | 'viewer' }
  | { status: 'deleted' }
  | { status: 'revoked' }
  | { status: 'error'; error: unknown }

export async function checkSession(id: string, tv: unknown): Promise<SessionCheck> {
  try {
    const row = await db.query.users.findFirst({
      where: eq(users.id, id),
      columns: { role: true, tokenVersion: true },
    })
    if (!row) return { status: 'deleted' }
    // Strict: a token minted before migration 0010 has no tv and is refused.
    if (tv !== row.tokenVersion) return { status: 'revoked' }
    return { status: 'ok', role: row.role as 'admin' | 'viewer' }
  } catch (error) {
    return { status: 'error', error }
  }
}

/**
 * In-process signal that a user's sessions just ended (token_version bumped or
 * the user deleted), so open SSE streams close at once instead of at their next
 * timed re-check. One container, one process: no cross-process fan-out needed.
 */
const revocations = globalSingleton('__piholeCentralSessionRevocations', () => {
  const e = new EventEmitter()
  e.setMaxListeners(0) // one listener per open stream; P3.3 caps streams per user
  return e
})

export function notifySessionsEnded(userId: string) {
  revocations.emit('ended', userId)
}

export function onSessionsEnded(listener: (userId: string) => void): () => void {
  revocations.on('ended', listener)
  return () => { revocations.off('ended', listener) }
}
