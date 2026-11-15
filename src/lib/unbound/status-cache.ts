import cron from 'node-cron'
import { db } from '@/lib/db'
import { instances, statsSnapshots } from '@/lib/db/schema'
import { desc, eq } from 'drizzle-orm'
import { isRecoveryActive } from '@/lib/ssh/recovery'
import { errMsg } from '@/lib/errors'
import { connectSSH, extractHost } from '@/lib/ssh/client'
import { checkUnbound, type UnboundCheck } from '@/lib/ssh/unbound'
import { notifyCondition } from '@/lib/notifications/center'

type UnboundStatusEntry = {
  status: 'running' | 'stopped' | 'unknown'
  checkedAt: Date
}

// globalThis singleton — Next.js standalone builds can create multiple module
// instances per SSR chunk; storing on globalThis ensures one shared Map.
declare const globalThis: typeof global & {
  __unboundCache?: Map<string, UnboundStatusEntry>
  __unboundBadStreak?: Map<string, number>
  __unboundCronStarted?: boolean
}
if (!globalThis.__unboundCache) globalThis.__unboundCache = new Map()
if (!globalThis.__unboundBadStreak) globalThis.__unboundBadStreak = new Map()
const cache = globalThis.__unboundCache
const badStreak = globalThis.__unboundBadStreak

// Consecutive bad minute-checks before unbound_down is raised. One bad reading
// is not enough: a restart (from the dashboard, or apt) shows as "activating"
// for a moment, and the Pi Zero replica's dig can miss one 2 s window on Wi-Fi.
const UNBOUND_DOWN_AFTER = 2

/**
 * Raise or clear the unbound_down condition from one minute-check. Called only
 * with a real reading: when the node is offline, in recovery or unreachable
 * over SSH nothing is known about Unbound, so the condition is left as it is
 * (the Offline alert covers that case, and resolving here would make every
 * recovery reboot flap this alert).
 */
async function recordUnboundCheck(instance: { id: string; name: string }, check: UnboundCheck): Promise<void> {
  if (check.state === 'running') {
    badStreak.delete(instance.id)
    await notifyCondition({
      type: 'unbound_down',
      severity: 'critical',
      title: `Unbound Down: ${instance.name}`,
      instanceId: instance.id,
      active: false,
    })
    return
  }
  const streak = (badStreak.get(instance.id) ?? 0) + 1
  badStreak.set(instance.id, streak)
  if (streak < UNBOUND_DOWN_AFTER) return
  // The title says WHICH failure it is, so a change from stopped to hung (or
  // back) resurfaces and re-pushes; the detail goes in the message.
  const what = check.state === 'stopped' ? 'Unbound Stopped' : 'Unbound Not Answering'
  await notifyCondition({
    type: 'unbound_down',
    severity: 'critical',
    title: `${what}: ${instance.name}`,
    message:
      `Unbound on ${instance.name} has been ${check.state === 'stopped' ? 'stopped' : 'not answering'} for ` +
      `${streak} checks in a row (${check.detail}). Pi-hole on this node cannot resolve anything it has not cached.`,
    instanceId: instance.id,
    active: true,
  })
}

export function getUnboundStatus(instanceId: string): UnboundStatusEntry {
  return cache.get(instanceId) ?? { status: 'unknown', checkedAt: new Date(0) }
}

async function isOffline(instanceId: string): Promise<boolean> {
  if (isRecoveryActive(instanceId)) return true
  const last = await db.query.statsSnapshots.findFirst({
    where: eq(statsSnapshots.instanceId, instanceId),
    orderBy: desc(statsSnapshots.timestamp),
  })
  return last?.status === 'offline'
}

async function refreshUnboundStatuses(): Promise<void> {
  const activeInstances = await db.query.instances.findMany({
    where: eq(instances.enabled, true),
  })
  // Drop entries for nodes that were deleted or disabled, so they don't keep
  // showing their last "running".
  const activeIds = new Set(activeInstances.map((i) => i.id))
  for (const id of cache.keys()) if (!activeIds.has(id)) cache.delete(id)

  await Promise.all(
    activeInstances
      .filter((i) => i.sshUsername)
      .map(async (instance) => {
        // Don't add an SSH session to a node the poller already has down or in
        // recovery: it can't answer usefully and only competes with recovery.
        if (await isOffline(instance.id)) {
          cache.set(instance.id, { status: 'unknown', checkedAt: new Date() })
          return
        }
        let ssh = null
        try {
          ssh = await connectSSH({
            host: extractHost(instance.url),
            username: instance.sshUsername!,
            passwordEncrypted: instance.sshPasswordEncrypted,
          })
          const check = await checkUnbound(ssh)
          // The dashboard badge stays about the process: a hung Unbound is
          // still "running" there, and the alert says what is wrong.
          cache.set(instance.id, {
            status: check.state === 'stopped' ? 'stopped' : 'running',
            checkedAt: new Date(),
          })
          await recordUnboundCheck(instance, check)
        } catch (err) {
          console.error(`[unbound] SSH check failed for ${instance.name}: ${errMsg(err)}`)
          cache.set(instance.id, { status: 'unknown', checkedAt: new Date() })
        } finally {
          if (ssh) ssh.dispose()
        }
      })
  )
}

export function startUnboundPolling(): void {
  if (globalThis.__unboundCronStarted) return
  globalThis.__unboundCronStarted = true
  console.log('[unbound] Starting background status polling (every minute, at :30)')
  refreshUnboundStatuses().catch((err) => console.error(`[unbound] refresh failed: ${errMsg(err)}`))
  // Second 30, not 0: the poller, watchdog and health SSH sessions all start at
  // :00, and the Pi Zero replica answers handshakes slowly under load. noOverlap
  // skips a tick if the previous refresh is still running.
  cron.schedule(
    '30 * * * * *',
    () => refreshUnboundStatuses().catch((err) => console.error(`[unbound] refresh failed: ${errMsg(err)}`)),
    { noOverlap: true }
  )
}
