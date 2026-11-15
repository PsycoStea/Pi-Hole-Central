import { db } from '@/lib/db'
import { recoveryEvents, appSettings } from '@/lib/db/schema'
import { and, count, desc, eq, gt } from 'drizzle-orm'
import { connectSSH, extractHost, getCloseWaitCount, nodeLocalCheck, restartFTL } from './client'
import { notify, notifyCondition } from '@/lib/notifications/center'
import { isRecoveryActive } from './recovery'
import { acquireNodeLock, getActiveNodeLock, releaseNodeLock } from '@/lib/ops/node-lock'
import { scaled } from '@/lib/ops/time-scale'
import { errMsg } from '@/lib/errors'

// Per-node cooldown and daily ceiling, both read from recovery_events (P5.6 /
// R2-NV5). They used to live in an in-memory map, so every app restart re-armed
// an immediate restart, and nothing capped restarts per day.
const WATCHDOG_RESTART_COOLDOWN_MS = 15 * 60 * 1000
const WATCHDOG_DAILY_MAX = 3
const DAY_MS = 24 * 60 * 60 * 1000

type InstanceRef = {
  id: string
  name: string
  url: string
  sshUsername: string | null
  sshPasswordEncrypted: string | null
}

export async function getWatchdogSettings() {
  const [en, th] = await Promise.all([
    db.query.appSettings.findFirst({ where: eq(appSettings.key, 'watchdog_enabled') }),
    db.query.appSettings.findFirst({ where: eq(appSettings.key, 'watchdog_threshold') }),
  ])
  return {
    enabled: (en?.value ?? 'true') === 'true',
    threshold: parseInt(th?.value ?? '30', 10),
  }
}

async function watchdogRestartsSince(instanceId: string, sinceMs: number): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(recoveryEvents)
    .where(and(
      eq(recoveryEvents.instanceId, instanceId),
      eq(recoveryEvents.eventType, 'watchdog_restart'),
      gt(recoveryEvents.timestamp, new Date(sinceMs))
    ))
  return row?.n ?? 0
}

async function lastWatchdogRestartAt(instanceId: string): Promise<number> {
  const row = await db.query.recoveryEvents.findFirst({
    where: and(eq(recoveryEvents.instanceId, instanceId), eq(recoveryEvents.eventType, 'watchdog_restart')),
    orderBy: desc(recoveryEvents.timestamp),
  })
  return row?.timestamp.getTime() ?? 0
}

async function logWatchdog(instanceId: string, eventType: string, detail: string, success = true): Promise<void> {
  await db.insert(recoveryEvents).values({ instanceId, timestamp: new Date(), eventType, detail, success })
}

/**
 * CLOSE-WAIT watchdog (audit P5.6 / R2-NV5).
 *
 * Restarting FTL takes the node's DNS down for a few seconds, so the watchdog
 * now restarts only when the leak has actually broken the API ON THE NODE
 * (loopback check over the same SSH session), never because the count alone
 * crossed the threshold; at most WATCHDOG_DAILY_MAX times per node per day
 * (then it raises an alert instead); and never while another node is being
 * restarted or this node is busy with an update, gravity run or backup.
 */
export async function runWatchdogCheck(instance: InstanceRef): Promise<void> {
  if (!instance.sshUsername) return
  // Don't restart FTL while a recovery restart loop is already in flight on the
  // same node — two concurrent restarts would fight each other.
  if (isRecoveryActive(instance.id)) return
  // Nor while an update, gravity run, backup (or recovery) holds the node.
  if (await getActiveNodeLock(instance.id)) return
  const { enabled, threshold } = await getWatchdogSettings()
  if (!enabled) return

  // Resolve the daily-ceiling alert once the 24 h window has room again.
  const restartsToday = await watchdogRestartsSince(instance.id, Date.now() - scaled(DAY_MS))
  if (restartsToday < WATCHDOG_DAILY_MAX) {
    await notifyCondition({
      type: 'watchdog_restart',
      severity: 'warning',
      title: `Watchdog Limit Reached: ${instance.name}`,
      instanceId: instance.id,
      active: false,
    })
  }

  let ssh = null
  let lock: Awaited<ReturnType<typeof acquireNodeLock>> = null
  try {
    ssh = await connectSSH({
      host: extractHost(instance.url),
      username: instance.sshUsername,
      passwordEncrypted: instance.sshPasswordEncrypted,
    })
    const count = await getCloseWaitCount(ssh)
    if (count <= 0) return

    if (count < threshold) {
      // Only record genuinely elevated counts, not every transient CLOSE-WAIT,
      // to avoid filling recovery_events with noise.
      if (count >= Math.max(2, Math.floor(threshold / 2))) {
        await db.insert(recoveryEvents).values({
          instanceId: instance.id,
          timestamp: new Date(),
          eventType: 'watchdog_elevated',
          detail: `CLOSE-WAIT: ${count} (threshold: ${threshold})`,
          success: true,
        })
      }
      return
    }

    // Threshold breached. Only act if the leak has actually broken the API on
    // the node itself: a high count alone is not an outage, and a restart
    // costs the node's DNS. Only a positive "no HTTP answer" lets us act.
    const local = await nodeLocalCheck(ssh)
    if (local.api !== 'down') {
      await logWatchdog(instance.id, 'watchdog_elevated', `CLOSE-WAIT: ${count} >= ${threshold}, but the node still answers locally (${local.detail}) — not restarting`)
      return
    }

    // Respect the restart cooldown so a persistent leak doesn't trigger a
    // restart+alert every single poll.
    if (Date.now() - (await lastWatchdogRestartAt(instance.id)) < scaled(WATCHDOG_RESTART_COOLDOWN_MS)) {
      await logWatchdog(instance.id, 'watchdog_elevated', `CLOSE-WAIT: ${count} >= ${threshold} but within restart cooldown — skipping restart`)
      return
    }

    // Daily ceiling: past it, escalate to a person instead of restarting again.
    if (restartsToday >= WATCHDOG_DAILY_MAX) {
      await logWatchdog(instance.id, 'watchdog_ceiling', `CLOSE-WAIT: ${count} >= ${threshold} and the API is down locally, but ${restartsToday} watchdog restarts already in 24 h — not restarting`, false)
      await notifyCondition({
        type: 'watchdog_restart',
        severity: 'critical',
        title: `Watchdog Limit Reached: ${instance.name}`,
        message: `${instance.name} keeps leaking connections (${count} in CLOSE-WAIT) and its API is down on the node, but the watchdog has already restarted pihole-FTL ${restartsToday} times in 24 hours. It will not restart again until the count drops; please check the node.`,
        instanceId: instance.id,
        active: true,
      })
      return
    }

    // Never restart two nodes at once (atomic, cross-node; also fails if the node got busy).
    lock = await acquireNodeLock(instance.id, 'watchdog')
    if (!lock) {
      await logWatchdog(instance.id, 'watchdog_elevated', `CLOSE-WAIT: ${count} >= ${threshold} but another node is being restarted or this node is busy — deferring`)
      return
    }

    const exitCode = await restartFTL(ssh)
    const success = exitCode === 0
    await logWatchdog(
      instance.id,
      'watchdog_restart',
      success
        ? `CLOSE-WAIT: ${count} >= ${threshold}, API down locally (${local.detail}). pihole-FTL restarted successfully.`
        : `CLOSE-WAIT: ${count} >= ${threshold}, API down locally (${local.detail}). Restart failed (exit code ${exitCode}).`,
      success
    )
    await dispatchWatchdogAlert(instance.id, instance.name, count, success)
  } catch (err) {
    console.error(`[watchdog] Check failed for ${instance.name}: ${errMsg(err)}`)
  } finally {
    if (ssh) ssh.dispose()
    await releaseNodeLock(lock)
  }
}

async function dispatchWatchdogAlert(
  instanceId: string,
  name: string,
  count: number,
  success: boolean
) {
  await notify({
    type: 'watchdog_restart',
    severity: success ? 'warning' : 'critical',
    title: success ? `Watchdog Restart: ${name}` : `Watchdog Failed: ${name}`,
    message: success
      ? `${name} had ${count} stuck CLOSE-WAIT connections. pihole-FTL restarted preventively.`
      : `${name} had ${count} stuck connections but the restart failed. Manual check needed.`,
    instanceId,
  })
}
