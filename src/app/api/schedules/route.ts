import { forgetSchedule, releaseSchedule, runScheduledProfiles, scheduleTargets, withScheduleLock } from '@/lib/dns/scheduler'
import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { requireAdmin } from '@/lib/auth-guard'
import { withApiError } from '@/lib/api/with-error'
import { db } from '@/lib/db'
import { dnsSchedules } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { logAudit } from '@/lib/audit'

export const dynamic = 'force-dynamic'

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

function validate(body: Record<string, unknown>): string | null {
  if (!body.name || typeof body.name !== 'string') return 'name is required'
  if (body.targetType !== 'blocking' && body.targetType !== 'group') return 'targetType must be blocking|group'
  if (body.targetType === 'group' && !body.targetGroup) return 'targetGroup is required for group schedules'
  if (typeof body.startTime !== 'string' || !TIME_RE.test(body.startTime)) return 'startTime must be HH:MM'
  if (typeof body.endTime !== 'string' || !TIME_RE.test(body.endTime)) return 'endTime must be HH:MM'
  if (!Array.isArray(body.instanceIds) || body.instanceIds.length === 0) return 'instanceIds must be a non-empty array'
  if (!Array.isArray(body.instanceIds) || body.instanceIds.some((i) => typeof i !== 'string')) return 'instanceIds must be strings'
  // At least one day: with none, the window never opens and the scheduler
  // enforces the out-of-window state every minute, forever.
  if (!Array.isArray(body.days) || body.days.length === 0 || body.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    return 'days must be a non-empty array of 0-6'
  }
  if (body.targetType === 'group' && typeof body.targetGroup !== 'string') return 'targetGroup must be a string'
  // Strings like "false" used to be stored as-is and read back as true.
  if (body.windowState !== undefined && typeof body.windowState !== 'boolean') return 'windowState must be a boolean'
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') return 'enabled must be a boolean'
  return null
}

export const GET = withApiError(async () => {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const rows = await db.query.dnsSchedules.findMany()
  return NextResponse.json(rows)
})

export const POST = withApiError(async (req: Request) => {
  const denied = await requireAdmin()
  if (denied) return denied
  const body = await req.json()
  const err = validate(body)
  if (err) return NextResponse.json({ error: err }, { status: 400 })
  const id = randomUUID()
  await db.insert(dnsSchedules).values({
    id,
    name: body.name,
    enabled: body.enabled ?? true,
    targetType: body.targetType,
    targetGroup: body.targetType === 'group' ? body.targetGroup : null,
    instanceIdsJson: JSON.stringify(body.instanceIds),
    daysJson: JSON.stringify(body.days),
    startTime: body.startTime,
    endTime: body.endTime,
    windowState: body.windowState ?? true,
    createdAt: new Date(),
  })
  await logAudit('schedule.create', id, body.name)
  return NextResponse.json({ id }, { status: 201 })
})

export const PUT = withApiError(async (req: Request) => {
  const denied = await requireAdmin()
  if (denied) return denied
  const body = await req.json()
  if (!body.id) return NextResponse.json({ error: 'id is required' }, { status: 400 })
  const old = await db.query.dnsSchedules.findFirst({ where: eq(dnsSchedules.id, body.id) })
  if (!old) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  // Allow a lightweight enabled-only toggle without full validation.
  if (Object.keys(body).length === 2 && typeof body.enabled === 'boolean') {
    // Disabling mid-window hands the targets back to their normal state.
    // Release and the DB change happen under the schedule lock, so an
    // evaluation already in flight finishes first and none starts in between.
    const failed = await withScheduleLock(async () => {
      const f = body.enabled ? [] : await releaseSchedule(old)
      await db.update(dnsSchedules).set({ enabled: body.enabled }).where(eq(dnsSchedules.id, body.id))
      forgetSchedule(body.id)
      return f
    })
    if (body.enabled) void runScheduledProfiles()
    await logAudit('schedule.toggle', body.id, body.enabled ? 'enabled' : 'disabled')
    return NextResponse.json({ ok: true, ...(failed.length && { releaseFailed: failed }) })
  }
  const err = validate(body)
  if (err) return NextResponse.json({ error: err }, { status: 400 })
  // Instances this schedule no longer governs (removed, or the target itself
  // changed) go back to normal before the new definition takes over.
  // Compared on the nodes each definition actually governs (scheduleTargets):
  // a group schedule covers every node once a primary is set, whatever is picked.
  const oldIds = await scheduleTargets(old)
  const newIds = await scheduleTargets({ targetType: body.targetType, instanceIdsJson: JSON.stringify(body.instanceIds) })
  const targetChanged = old.targetType !== body.targetType || (old.targetGroup ?? null) !== (body.targetType === 'group' ? body.targetGroup : null)
  const dropped = targetChanged ? oldIds : oldIds.filter((i) => !newIds.includes(i))
  await withScheduleLock(async () => {
    if (dropped.length) await releaseSchedule(old, dropped)
    forgetSchedule(body.id)
    await db
      .update(dnsSchedules)
      .set({
        name: body.name,
        // Keep the stored on/off unless the caller explicitly sets it — editing
        // a paused schedule used to switch it back on.
        enabled: typeof body.enabled === 'boolean' ? body.enabled : old.enabled,
        targetType: body.targetType,
        targetGroup: body.targetType === 'group' ? body.targetGroup : null,
        instanceIdsJson: JSON.stringify(body.instanceIds),
        daysJson: JSON.stringify(body.days),
        startTime: body.startTime,
        endTime: body.endTime,
        windowState: body.windowState ?? true,
      })
      .where(eq(dnsSchedules.id, body.id))
  })
  void runScheduledProfiles() // apply the new definition now, not up to a minute later
  await logAudit('schedule.update', body.id, body.name)
  return NextResponse.json({ ok: true })
})

export const DELETE = withApiError(async (req: Request) => {
  const denied = await requireAdmin()
  if (denied) return denied
  const body = await req.json().catch(() => ({}))
  if (!body.id) return NextResponse.json({ error: 'id is required' }, { status: 400 })
  const old = await db.query.dnsSchedules.findFirst({ where: eq(dnsSchedules.id, body.id) })
  const failed = await withScheduleLock(async () => {
    const f = old ? await releaseSchedule(old) : []
    await db.delete(dnsSchedules).where(eq(dnsSchedules.id, body.id))
    return f
  })
  await logAudit('schedule.delete', body.id, old?.name ?? '')
  return NextResponse.json({ ok: true, ...(failed.length && { releaseFailed: failed }) })
})
