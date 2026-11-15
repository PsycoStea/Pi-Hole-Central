import { db } from '@/lib/db'
import { notifications, alertSettings } from '@/lib/db/schema'
import { and, eq, isNull } from 'drizzle-orm'
import { dispatch } from './index'
import { errMsg } from '@/lib/errors'

export type Severity = 'info' | 'warning' | 'critical'

const SEVERITY_RANK: Record<Severity, number> = { info: 0, warning: 1, critical: 2 }

export type NotifyInput = {
  type: string
  severity: Severity
  title: string
  message?: string
  instanceId?: string | null
}

/**
 * Single choke point for user-facing notifications. Always persists an in-app
 * notification row; optionally also pushes to outbound channels (Gotify/etc.)
 * when the alert type has push enabled and the severity clears its threshold.
 *
 * Best-effort: never throws (callers are often fire-and-forget in the poll loop).
 */
export async function notify(input: NotifyInput): Promise<void> {
  const severity = input.severity
  try {
    const setting = await db.query.alertSettings.findFirst({
      where: eq(alertSettings.type, input.type),
    })

    // If a setting row exists and the type is disabled, skip entirely (no in-app,
    // no push). Types with no row (unexpected) still record in-app by default.
    if (setting && !setting.enabled) return

    let pushed = false
    if (setting?.pushEnabled) {
      const minRank = SEVERITY_RANK[(setting.minPushSeverity as Severity) ?? 'warning'] ?? 1
      if (SEVERITY_RANK[severity] >= minRank) {
        const channelIds: string[] = JSON.parse(setting.channelIdsJson || '[]')
        if (channelIds.length) {
          await dispatch(input.title, input.message ?? '', channelIds)
          pushed = true
        }
      }
    }

    await db.insert(notifications).values({
      type: input.type,
      severity,
      title: input.title,
      message: input.message ?? '',
      instanceId: input.instanceId ?? null,
      read: false,
      pushed,
      timestamp: new Date(),
    })
  } catch (err) {
    console.error(`[notify] Failed to record notification (${input.type}): ${errMsg(err)}`)
  }
}

/** The live (unresolved) sticky row for a condition, or undefined. */
async function findLive(type: string, instanceId: string | null) {
  return db.query.notifications.findFirst({
    where: and(
      eq(notifications.type, type),
      eq(notifications.sticky, true),
      isNull(notifications.resolvedAt),
      instanceId === null
        ? isNull(notifications.instanceId)
        : eq(notifications.instanceId, instanceId)
    ),
  })
}

/**
 * Current severity of a live condition, or null if it is not currently raised.
 *
 * Reads the database rather than an in-memory map, so hysteresis and
 * raise/resolve decisions survive a restart.
 */
export async function getConditionSeverity(
  type: string,
  instanceId: string | null = null
): Promise<Severity | null> {
  try {
    const live = await findLive(type, instanceId)
    return (live?.severity as Severity | undefined) ?? null
  } catch (err) {
    console.error(`[notify] Failed to read condition state (${type}):`, err)
    return null
  }
}

export type ConditionInput = NotifyInput & {
  /** Whether the condition is currently true. */
  active: boolean
}

/**
 * What notifyCondition() did. Callers that need to pair a condition with an
 * event (offline -> "Recovered") key off 'resolved', which happens exactly once
 * per raise, so the pair can never double-fire or go missing.
 */
export type ConditionTransition = 'raised' | 'escalated' | 'changed' | 'refreshed' | 'resolved' | 'none'

/**
 * Record an ongoing CONDITION (a state), as opposed to an event.
 *
 * Keeps exactly one live row per (type, instanceId) for as long as the condition
 * holds, updating its severity/message in place, and marks it resolved when it
 * clears. An unchanging problem is therefore a standing indicator rather than a
 * repeat ping every poll — which is the whole point: the old code re-notified
 * hourly and produced 488 rows in a week from two unchanging conditions.
 *
 * Outbound pushes fire on first raise and on severity escalation only, never on
 * routine in-place refreshes.
 *
 * Best-effort: never throws (callers are fire-and-forget in the poll loop).
 */
export async function notifyCondition(input: ConditionInput): Promise<ConditionTransition> {
  try {
    const setting = await db.query.alertSettings.findFirst({
      where: eq(alertSettings.type, input.type),
    })
    const instanceId = input.instanceId ?? null
    const live = await findLive(input.type, instanceId)
    const now = new Date()

    // A disabled type raises nothing, but it must still be able to RESOLVE a
    // row raised while it was enabled — otherwise the row stays live forever
    // (and the clear-all route deliberately skips live rows).
    if (setting && !setting.enabled && input.active) return 'none'

    if (!input.active) {
      // Resolve, if it was raised. Nothing to do otherwise — a condition that
      // was never true does not need a "still fine" record.
      if (live) {
        await db
          .update(notifications)
          .set({ resolvedAt: now, timestamp: now })
          .where(eq(notifications.id, live.id))
        return 'resolved'
      }
      return 'none'
    }

    const escalated =
      live !== undefined &&
      SEVERITY_RANK[input.severity] > SEVERITY_RANK[(live.severity as Severity) ?? 'info']

    // A changed TITLE means the nature of the problem changed, not just its
    // magnitude — so it must resurface even though the condition was already
    // live. Without this, a permanently-active condition masks new ones: with
    // gravity counts always slightly apart (nodes build their lists
    // independently by design), a genuine config drift would otherwise only
    // rewrite the message of an already-read row and never draw attention.
    // Callers encode "what is wrong" in the title to get this.
    const changedNature = live !== undefined && live.title !== input.title

    if (live) {
      // Refresh in place: same row, current detail. Re-open unread when the
      // condition worsens or changes character, so it resurfaces in the bell.
      await db
        .update(notifications)
        .set({
          severity: input.severity,
          title: input.title,
          message: input.message ?? '',
          timestamp: now,
          ...(escalated || changedNature ? { read: false } : {}),
        })
        .where(eq(notifications.id, live.id))
      // Push only when it worsened or changed character — never on a routine
      // refresh, which is what keeps an ongoing problem from re-pinging.
      if (!escalated && !changedNature) return 'refreshed'
    }

    const pushed = await maybePush(setting, input)

    if (!live) {
      await db.insert(notifications).values({
        type: input.type,
        severity: input.severity,
        title: input.title,
        message: input.message ?? '',
        instanceId,
        read: false,
        pushed,
        timestamp: now,
        sticky: true,
        raisedAt: now,
        resolvedAt: null,
      })
      return 'raised'
    }
    return escalated ? 'escalated' : 'changed'
  } catch (err) {
    console.error(`[notify] Failed to record condition (${input.type}): ${errMsg(err)}`)
    return 'none'
  }
}

/**
 * Resolve every live condition row, optionally only of one type or for one
 * instance. Used when an alert type is switched off or an instance is removed
 * or disabled — nothing will ever poll those again to clear them.
 */
export async function resolveLiveConditions(filter: { type?: string; instanceId?: string }): Promise<void> {
  const now = new Date()
  const where = [eq(notifications.sticky, true), isNull(notifications.resolvedAt)]
  if (filter.type) where.push(eq(notifications.type, filter.type))
  if (filter.instanceId) where.push(eq(notifications.instanceId, filter.instanceId))
  await db.update(notifications).set({ resolvedAt: now, timestamp: now }).where(and(...where))
}

/** Shared push gate: honours pushEnabled, severity threshold and channel list. */
async function maybePush(
  setting: typeof alertSettings.$inferSelect | undefined,
  input: NotifyInput
): Promise<boolean> {
  if (!setting?.pushEnabled) return false
  const minRank = SEVERITY_RANK[(setting.minPushSeverity as Severity) ?? 'warning'] ?? 1
  if (SEVERITY_RANK[input.severity] < minRank) return false
  const channelIds: string[] = JSON.parse(setting.channelIdsJson || '[]')
  if (!channelIds.length) return false
  await dispatch(input.title, input.message ?? '', channelIds)
  return true
}
