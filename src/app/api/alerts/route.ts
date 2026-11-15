import { NextResponse } from 'next/server'
import { resolveLiveConditions } from '@/lib/notifications/center'
import { auth } from '@/lib/auth'
import { requireAdmin } from '@/lib/auth-guard'
import { db } from '@/lib/db'
import { alertSettings } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { logAudit } from '@/lib/audit'

export async function GET() {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const settings = await db.query.alertSettings.findMany()
  return NextResponse.json(settings)
}

export async function PUT(req: Request) {
  const denied = await requireAdmin()
  if (denied) return denied
  const { id, enabled, threshold, channelIds, pushEnabled, minPushSeverity } = await req.json()
  const update: Partial<typeof alertSettings.$inferInsert> = {}
  if (typeof enabled === 'boolean') update.enabled = enabled
  // null means "no change": alerts without a threshold (offline, recovery,
  // watchdog...) store null and the page sends it back on every save. It must
  // never overwrite a stored value, which is how a cleared field (NaN -> null)
  // used to silently disable the low-block-rate check.
  if (threshold !== undefined && threshold !== null) {
    if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
      return NextResponse.json({ error: 'threshold must be a number from 0 to 100' }, { status: 400 })
    }
    update.threshold = threshold
  }
  if (channelIds !== undefined) {
    if (!Array.isArray(channelIds) || channelIds.some((c) => typeof c !== 'string')) {
      return NextResponse.json({ error: 'channelIds must be an array of strings' }, { status: 400 })
    }
    update.channelIdsJson = JSON.stringify(channelIds)
  }
  if (typeof pushEnabled === 'boolean') update.pushEnabled = pushEnabled
  if (minPushSeverity !== undefined) {
    if (!['info', 'warning', 'critical'].includes(minPushSeverity)) {
      return NextResponse.json({ error: 'minPushSeverity must be info|warning|critical' }, { status: 400 })
    }
    update.minPushSeverity = minPushSeverity
  }
  if (typeof id !== 'string' || !id) {
    return NextResponse.json({ error: 'id is required' }, { status: 400 })
  }
  // Nothing to change (e.g. only a null threshold): drizzle throws on an empty SET.
  if (Object.keys(update).length === 0) return NextResponse.json({ ok: true })
  await db.update(alertSettings).set(update).where(eq(alertSettings.id, id))
  const row = await db.query.alertSettings.findFirst({ where: eq(alertSettings.id, id) })
  if (update.enabled === false) {
    // Nothing will evaluate a disabled type again, so its live rows would stay
    // in the bell forever (and clear-all skips live rows by design).
    if (row) await resolveLiveConditions({ type: row.type })
  }
  await logAudit(
    'alert.update',
    id,
    `${row?.type ?? '?'}: ` +
      Object.entries(update).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ')
  )
  return NextResponse.json({ ok: true })
}
