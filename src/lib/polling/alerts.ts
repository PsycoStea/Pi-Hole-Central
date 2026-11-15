import { db } from '@/lib/db'
import { alertSettings, instances } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { notifyCondition } from '@/lib/notifications/center'
import { errMsg } from '@/lib/errors'
import * as piholeClient from '@/lib/pihole/client'
import type { PiHoleSummary } from '@/lib/pihole/types'
import { globalSingleton } from '@/lib/global-state'

// The blocking check is a Pi-hole API call on top of the per-poll getSummary, so
// at poll_interval_seconds=60 it would double steady-state request volume against
// FTL. pihole-FTL v6.6.2 leaks CLOSE-WAIT sockets (see the watchdog + the
// 2026-06 incident), and doubling churn doubles watchdog-triggered FTL restarts.
// Edge detection doesn't need 60s granularity — a few minutes' delay on "blocking
// got switched off" is immaterial — so self-gate to 5 minutes.
const BLOCKING_CHECK_INTERVAL_MS = 5 * 60 * 1000
const blockingCheckedAt = globalSingleton(
  '__piholeCentralBlockingCheckedAt',
  () => new Map<string, number>()
)

function shouldFetchBlocking(instanceId: string): boolean {
  const last = blockingCheckedAt.get(instanceId) ?? 0
  if (Date.now() - last < BLOCKING_CHECK_INTERVAL_MS) return false
  blockingCheckedAt.set(instanceId, Date.now())
  return true
}

/**
 * Real blocking state for an instance, or null if it could not be determined.
 *
 * Must come from `/api/dns/blocking` — `/api/stats/summary` does not carry it.
 * Returning null on failure is deliberate: an unreachable endpoint is not
 * evidence that blocking is off, and treating it as such is exactly the bug
 * that produced 330 spurious blocking_disabled notifications.
 */
async function fetchBlockingState(instanceId: string): Promise<'enabled' | 'disabled' | 'failed' | 'unknown' | null> {
  try {
    const status = await piholeClient.getBlockingStatus(instanceId)
    return status.blocking ?? null
  } catch (err) {
    console.error(`[alerts] Blocking status unavailable for ${instanceId}: ${errMsg(err)}`)
    return null
  }
}

export async function checkAlerts(
  instance: typeof instances.$inferSelect,
  summary: PiHoleSummary | null,
  currentStatus: 'online' | 'offline'
) {
  const settings = await db.query.alertSettings.findMany({
    where: eq(alertSettings.enabled, true),
  })

  // Only pay for the extra Pi-hole call when the alert type is actually enabled,
  // the node is up enough to answer, and the 5-minute gate has elapsed. A skipped
  // check yields null, which holds the existing edge state rather than clearing it.
  const blockingState =
    currentStatus === 'online' &&
    settings.some((s) => s.type === 'blocking_disabled') &&
    shouldFetchBlocking(instance.id)
      ? await fetchBlockingState(instance.id)
      : null

  for (const setting of settings) {
    // No channel gate here — every enabled alert type records an in-app
    // notification; notify() decides whether to ALSO push to channels.
    //
    // 'offline' and 'recovery' are not handled here: offline is a live
    // condition raised by worker.ts/recovery.ts and resolved by the poller,
    // which emits 'recovery' exactly once when it resolves.
    switch (setting.type) {
      case 'blocking_disabled': {
        // blockingState === null means "couldn't tell" (node offline, gate not
        // yet elapsed, or the call failed) — leave the live condition untouched
        // rather than inventing a transition in either direction. 'unknown' is
        // treated the same way: it is not a claim that blocking is off, so it
        // must not raise, and not a claim that it is on, so it must not resolve.
        // 'failed' (v6: FTL couldn't apply the state) is likewise not a claim either way.
        if (blockingState === null || blockingState === 'unknown' || blockingState === 'failed') break
        await notifyCondition({
          type: 'blocking_disabled',
          severity: 'warning',
          title: `Blocking Disabled: ${instance.name}`,
          message: `Ad blocking is disabled on ${instance.name} (${instance.url}).`,
          instanceId: instance.id,
          active: blockingState === 'disabled',
        })
        break
      }

      case 'block_rate_low': {
        // Same rule as above: no reading (offline / no summary) is not evidence
        // the rate is fine, so leave the live condition alone.
        if (currentStatus !== 'online' || !summary || setting.threshold === null) break
        const threshold = setting.threshold ?? 5
        const percent = summary.queries.percent_blocked
        await notifyCondition({
          type: 'block_rate_low',
          severity: 'warning',
          title: `Low Block Rate: ${instance.name}`,
          message: `Block rate on ${instance.name} is ${percent.toFixed(1)}% — below the ${threshold}% threshold.`,
          instanceId: instance.id,
          active: percent < threshold,
        })
        break
      }
    }
  }
}
