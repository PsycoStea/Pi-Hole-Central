import { db } from '@/lib/db'
import { auditLog } from '@/lib/db/schema'
import { errMsg } from '@/lib/errors'
import { eq } from 'drizzle-orm'
import { auth } from '@/lib/auth'
import { headers } from 'next/headers'
import { randomUUID } from 'crypto'
import { isIP } from 'net'

// The audit trail has its own retention, never shorter than 30 days, so that
// shortening stats retention (1-30 days) cannot also wipe who-changed-what.
export const AUDIT_RETENTION_MIN = 30
export const AUDIT_RETENTION_DEFAULT = 90

// Records who changed what in the dashboard. Best-effort: auditing must never
// break the underlying action, so everything here swallows its own errors.
export async function logAudit(
  action: string,
  target = '',
  detail = '',
  // Sign-in has no session yet, so it names the actor itself.
  actor?: { id: string; name: string }
): Promise<string | null> {
  try {
    const session = actor ? null : await auth()
    let ip = ''
    try {
      const h = await headers()
      // X-Real-IP only. NPM overwrites it with the peer address
      // (proxy_set_header X-Real-IP $remote_addr) and :3100 accepts only NPM.
      // X-Forwarded-For is appended to, so its leftmost entry is whatever the
      // client sent (R1-F4). Anything that is not a plain IP is dropped.
      const real = (h.get('x-real-ip') ?? '').trim()
      ip = isIP(real) ? real : ''
    } catch {
      /* headers() unavailable outside a request */
    }
    const id = randomUUID()
    await db.insert(auditLog).values({
      id,
      timestamp: new Date(),
      userId: actor?.id ?? session?.user?.id ?? '',
      username: actor?.name ?? session?.user?.name ?? 'unknown',
      action,
      target,
      detail,
      ip,
    })
    return id
  } catch (err) {
    console.error('[audit] failed to record:', err)
    return null
  }
}

/**
 * Audit a call that changes a Pi-hole node. The row is written BEFORE the
 * call, marked [pending], and settled to [ok] or [failed: ...] afterwards. The
 * node may apply a change and still answer non-2xx or time out (R3B-NV2:
 * FTL applies a Teleporter import and then returns 400), so writing the row
 * only on success left changes with no audit trail. A row left [pending]
 * means the process stopped mid-call.
 */
export async function auditedNodeCall<T>(
  action: string,
  target: string,
  detail: string,
  call: () => Promise<T>,
  describeResult?: (r: T) => string
): Promise<T> {
  const rowId = await logAudit(action, target, `${detail} [pending]`.trim())
  const settle = async (outcome: string) => {
    if (!rowId) return
    try {
      await db.update(auditLog).set({ detail: `${detail} [${outcome}]`.trim() }).where(eq(auditLog.id, rowId))
    } catch (err) {
      console.error('[audit] failed to settle:', err)
    }
  }
  try {
    const r = await call()
    const extra = describeResult?.(r)
    await settle(extra ? `ok: ${extra}` : 'ok')
    return r
  } catch (err) {
    await settle(`failed: ${errMsg(err).slice(0, 300)}`)
    throw err
  }
}
