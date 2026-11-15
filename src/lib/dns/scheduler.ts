import { errMsg } from '@/lib/errors'
import { db } from '@/lib/db'
import { dnsSchedules, tempAllows, appSettings, instances } from '@/lib/db/schema'
import { and, eq, lt } from 'drizzle-orm'
import * as piholeClient from '@/lib/pihole/client'
import { globalSingleton } from '@/lib/global-state'
import { getPrimaryNode } from '@/lib/nebula/primary'

const DEFAULT_TZ = 'Africa/Johannesburg'

// Last-applied desired state per (schedule, instance, target) so we only hit the
// Pi-hole API when the scheduled state actually changes. globalThis-anchored.
const scheduleState = globalSingleton('__piholeCentralScheduleState', () => ({
  applied: new Map<string, boolean>(),
  running: false,
  lock: Promise.resolve() as Promise<unknown>,
}))

/**
 * One holder at a time for "apply schedule state to nodes": the minute
 * evaluation, and a route's release + DB change. An evaluation that loaded a
 * schedule before it was disabled used to apply the window state AFTER the
 * release, leaving e.g. blocking off with no schedule governing it (R2-F5).
 * Not re-entrant: never call it from inside fn.
 */
export function withScheduleLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = scheduleState.lock.then(fn, fn)
  scheduleState.lock = run.catch(() => {})
  return run
}

type ScheduleRow = typeof dnsSchedules.$inferSelect

/**
 * The nodes a schedule actually governs.
 *
 * Group schedules, once a nebula-sync primary is set, apply to EVERY enabled
 * node regardless of the stored picks. Groups are config that nebula-sync
 * copies from the primary, so a group toggled on a replica alone was undone
 * within 15 minutes, and toggled on the primary alone reached the replicas up
 * to 15 minutes late. Switching it everywhere at once takes effect immediately
 * and agrees with what the next sync writes. Blocking on/off is runtime state
 * (not synced), so blocking schedules keep their per-node picks.
 */
export async function scheduleTargets(
  s: Pick<ScheduleRow, 'targetType' | 'instanceIdsJson'>
): Promise<string[]> {
  let picked: string[] = []
  try {
    picked = JSON.parse(s.instanceIdsJson)
  } catch {
    return []
  }
  if (s.targetType !== 'group' || !(await getPrimaryNode())) return picked
  const rows = await db.query.instances.findMany({ where: eq(instances.enabled, true) })
  return rows.map((r) => r.id)
}

function parseSchedule(s: ScheduleRow): { days: number[]; instanceIds: string[] } | null {
  try {
    return { days: JSON.parse(s.daysJson), instanceIds: JSON.parse(s.instanceIdsJson) }
  } catch {
    return null
  }
}

async function isInWindowNow(s: ScheduleRow, days: number[]): Promise<boolean> {
  const { day, minutes } = nowInTz(await getTimeZone())
  const [sh, sm] = s.startTime.split(':').map(Number)
  const [eh, em] = s.endTime.split(':').map(Number)
  return computeInWindow(days, sh * 60 + sm, eh * 60 + em, day, minutes)
}

async function applyState(s: ScheduleRow, instId: string, state: boolean): Promise<void> {
  if (s.targetType === 'blocking') await piholeClient.setBlocking(instId, state)
  else if (s.targetGroup) await piholeClient.updateGroup(instId, s.targetGroup, { enabled: state })
}

/** Forget what was applied for a schedule, so the next run re-evaluates it from scratch. */
export function forgetSchedule(scheduleId: string): void {
  for (const key of scheduleState.applied.keys()) {
    if (key.startsWith(`${scheduleId}:`)) scheduleState.applied.delete(key)
  }
}

/**
 * Hand a schedule's targets back to their normal (out-of-window) state when it
 * stops governing them — on disable, delete, or when an edit drops an instance
 * or changes the target. Only needed while the window is OPEN: outside it the
 * normal state is already in place. Previously, disabling or deleting a
 * "blocking off 17:00-19:00" schedule at 18:00 left blocking off indefinitely.
 * Call it inside withScheduleLock, together with the DB change that stops the
 * schedule governing those targets.
 */
export async function releaseSchedule(s: ScheduleRow, onlyInstances?: string[]): Promise<string[]> {
  const parsed = parseSchedule(s)
  forgetSchedule(s.id)
  if (!parsed || !s.enabled) return []
  if (!(await isInWindowNow(s, parsed.days))) return []
  const targets = onlyInstances ?? (await scheduleTargets(s))
  const failed: string[] = []
  for (const instId of targets) {
    try {
      await applyState(s, instId, !s.windowState)
    } catch (err) {
      console.error(`[scheduler] release of "${s.name}" on ${instId} failed: ${errMsg(err)}`)
      failed.push(instId)
    }
  }
  return failed
}

const DAY_MAP: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

async function getTimeZone(): Promise<string> {
  const s = await db.query.appSettings.findFirst({ where: eq(appSettings.key, 'timezone') })
  return s?.value || DEFAULT_TZ
}

function nowInTz(tz: string): { day: number; minutes: number } {
  const now = new Date()
  let day = 0
  let minutes = 0
  try {
    const wd = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(now)
    day = DAY_MAP[wd] ?? 0
    const hm = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(now)
    const [h, m] = hm.split(':').map(Number)
    minutes = (h % 24) * 60 + m
  } catch {
    // Invalid tz — fall back to UTC-ish local.
    day = now.getUTCDay()
    minutes = now.getUTCHours() * 60 + now.getUTCMinutes()
  }
  return { day, minutes }
}

function computeInWindow(
  days: number[],
  startMin: number,
  endMin: number,
  day: number,
  nowMin: number
): boolean {
  const overnight = endMin <= startMin
  if (!overnight) {
    return days.includes(day) && nowMin >= startMin && nowMin < endMin
  }
  // Window spans midnight: [start, 24:00) on the selected day + [0, end) the next day.
  const prevDay = (day + 6) % 7
  if (days.includes(day) && nowMin >= startMin) return true
  if (days.includes(prevDay) && nowMin < endMin) return true
  return false
}

/** Evaluate all enabled schedules and enforce their target state. Runs every minute. */
export async function runScheduledProfiles(): Promise<void> {
  // The cron fires every minute and does not wait for the previous run; a slow
  // node (group PUT = GET + PUT) must not let two runs apply at once.
  if (scheduleState.running) return
  scheduleState.running = true
  try {
    await withScheduleLock(() => evaluateSchedules())
  } finally {
    scheduleState.running = false
  }
}

async function evaluateSchedules(): Promise<void> {
  let schedules
  try {
    schedules = await db.query.dnsSchedules.findMany({ where: eq(dnsSchedules.enabled, true) })
  } catch (err) {
    console.error(`[scheduler] failed to load schedules: ${errMsg(err)}`)
    return
  }
  if (!schedules.length) return

  const tz = await getTimeZone()
  const { day, minutes } = nowInTz(tz)

  for (const s of schedules) {
    let days: number[] = []
    try {
      days = JSON.parse(s.daysJson)
    } catch {
      continue
    }
    const instanceIds = await scheduleTargets(s)
    const [sh, sm] = s.startTime.split(':').map(Number)
    const [eh, em] = s.endTime.split(':').map(Number)
    const inWindow = computeInWindow(days, sh * 60 + sm, eh * 60 + em, day, minutes)
    const desired = inWindow ? s.windowState : !s.windowState

    for (const instId of instanceIds) {
      const key = `${s.id}:${instId}:${s.targetType}:${s.targetGroup ?? ''}`
      if (scheduleState.applied.get(key) === desired) continue
      try {
        await applyState(s, instId, desired)
        scheduleState.applied.set(key, desired)
      } catch (err) {
        console.error(`[scheduler] apply failed for "${s.name}" on ${instId}: ${errMsg(err)}`)
      }
    }
  }
}

/** Revert temporary allow/deny entries whose expiry has passed. Runs every minute. */
export async function runTempAllowRevert(): Promise<void> {
  let expired
  try {
    expired = await db.query.tempAllows.findMany({
      where: and(eq(tempAllows.reverted, false), lt(tempAllows.expiresAt, new Date())),
    })
  } catch (err) {
    console.error('[scheduler] failed to load temp allows:', err)
    return
  }
  for (const t of expired) {
    try {
      await piholeClient.removeDomain(t.instanceId, t.list as 'allow' | 'deny', t.kind, t.domain)
    } catch (err) {
      // 404 = already gone (removed by hand): done. Anything else (node down,
      // auth failure) must NOT be marked reverted — that used to leave the
      // "temporary" entry on the node permanently. Retry next minute.
      if (!piholeClient.isNotFound(err)) {
        console.error(`[scheduler] temp-allow revert of ${t.domain} on ${t.instanceId} failed, will retry: ${errMsg(err)}`)
        continue
      }
    }
    // Only a node that no longer lists the entry counts as reverted: a 2xx
    // or 404 on the DELETE is not proof (R2-F6: a dot-segment DELETE hit a
    // different path and answered 2xx while the entry stayed).
    try {
      if (!(await piholeClient.isDomainGone(t.instanceId, t.list as 'allow' | 'deny', t.kind, t.domain))) {
        console.error(`[scheduler] temp-allow ${t.domain} still on ${t.instanceId} after removal, will retry`)
        continue
      }
    } catch (err) {
      console.error(`[scheduler] could not confirm temp-allow revert of ${t.domain}, will retry: ${errMsg(err)}`)
      continue
    }
    try {
      await db.update(tempAllows).set({ reverted: true }).where(eq(tempAllows.id, t.id))
    } catch (err) {
      console.error('[scheduler] failed to mark temp-allow reverted:', err)
    }
  }
}
