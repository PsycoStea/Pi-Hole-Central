import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth-guard'
import { withApiError } from '@/lib/api/with-error'
import { db } from '@/lib/db'
import { logAudit } from '@/lib/audit'
import { notifications } from '@/lib/db/schema'
import { and, desc, asc, eq, count, inArray, isNull, isNotNull, not, or, type SQL } from 'drizzle-orm'

export const dynamic = 'force-dynamic'

/** Rows for conditions that are true right now: sticky and not yet resolved. */
const LIVE = and(eq(notifications.sticky, true), isNull(notifications.resolvedAt))!

/**
 * The event feed: everything that is NOT a currently-live condition. Resolved
 * sticky rows belong here (they are history); live ones are surfaced separately
 * so an ongoing problem reads as a standing indicator rather than scrolling away.
 */
const NOT_LIVE = or(eq(notifications.sticky, false), isNotNull(notifications.resolvedAt))!

export const GET = withApiError(async (req: Request) => {
  const denied = await requireAdmin()
  if (denied) return denied

  const params = new URL(req.url).searchParams

  // Lightweight badge endpoint. The badge counts unread events PLUS every live
  // condition — an ongoing problem should keep showing even once it is read,
  // otherwise "persistent" would only last until the first glance.
  if (params.get('unread') === '1') {
    const [[unreadRow], [activeRow]] = await Promise.all([
      db.select({ c: count() }).from(notifications).where(and(eq(notifications.read, false), NOT_LIVE)),
      db.select({ c: count() }).from(notifications).where(LIVE),
    ])
    const active = activeRow?.c ?? 0
    return NextResponse.json({ count: (unreadRow?.c ?? 0) + active, active })
  }

  const conds: SQL[] = []
  const type = params.get('type')
  const severity = params.get('severity')
  const read = params.get('read')
  if (type) conds.push(eq(notifications.type, type))
  if (severity) conds.push(eq(notifications.severity, severity))
  if (read === 'true') conds.push(eq(notifications.read, true))
  if (read === 'false') conds.push(eq(notifications.read, false))
  // The feed never includes live conditions — those come back in `active`.
  const where = and(NOT_LIVE, ...conds)

  const limit = Math.min(200, Math.max(1, parseInt(params.get('limit') ?? '30', 10) || 30))
  const offset = Math.max(0, parseInt(params.get('offset') ?? '0', 10) || 0)

  const [rows, [totalRow], [unreadRow], active] = await Promise.all([
    db.query.notifications.findMany({
      where,
      orderBy: desc(notifications.timestamp),
      limit,
      offset,
    }),
    db.select({ c: count() }).from(notifications).where(where),
    db.select({ c: count() }).from(notifications).where(and(eq(notifications.read, false), NOT_LIVE)),
    // Oldest first: the longest-standing problem is the one to look at.
    db.query.notifications.findMany({ where: LIVE, orderBy: asc(notifications.raisedAt) }),
  ])

  return NextResponse.json({
    notifications: rows,
    active,
    total: totalRow?.c ?? 0,
    unread: unreadRow?.c ?? 0,
  })
})

export const DELETE = withApiError(async (req: Request) => {
  const denied = await requireAdmin()
  if (denied) return denied

  const body = await req.json().catch(() => ({}))
  const ids: number[] | undefined = Array.isArray(body.ids) ? body.ids : undefined
  const scope: string | undefined = body.scope

  // Live conditions are never deletable: the next check would immediately
  // recreate the row, so "clear all" would silently do nothing for them and
  // look broken. They disappear on their own when the condition resolves.
  if (ids && ids.length) {
    await db.delete(notifications).where(and(inArray(notifications.id, ids), NOT_LIVE))
  } else if (scope === 'read') {
    await db.delete(notifications).where(and(eq(notifications.read, true), NOT_LIVE))
  } else if (scope === 'all') {
    await db.delete(notifications).where(NOT_LIVE)
  } else {
    return NextResponse.json({ error: 'Provide ids[] or scope=read|all' }, { status: 400 })
  }
  await logAudit('notifications.delete', '', ids && ids.length ? `${ids.length} id(s)` : `scope=${scope}`)
  return NextResponse.json({ ok: true })
})
