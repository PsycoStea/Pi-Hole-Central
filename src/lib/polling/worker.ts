import cron from 'node-cron'
import { db } from '@/lib/db'
import { instances, statsSnapshots, appSettings, recoveryEvents, notifications, auditLog } from '@/lib/db/schema'
import { AUDIT_RETENTION_DEFAULT, AUDIT_RETENTION_MIN } from '@/lib/audit'
import { and, eq, isNotNull, lt, or } from 'drizzle-orm'
import * as piholeClient from '@/lib/pihole/client'
import type { TopDomain, TopClient, PiHoleSummary } from '@/lib/pihole/types'
import { checkAlerts } from './alerts'
import { runRecovery, isRecoveryActive, clearRecoveryState, raiseOffline } from '@/lib/ssh/recovery'
import { notify, notifyCondition } from '@/lib/notifications/center'
import { errMsg } from '@/lib/errors'
import { runWatchdogCheck } from '@/lib/ssh/watchdog'
import { runHealthChecks, runHostDiskCheck } from '@/lib/ssh/health'
import { runScheduledProfiles, runTempAllowRevert } from '@/lib/dns/scheduler'
import { runScheduledBackups } from '@/lib/backup/service'
import { runNebulaDriftCheck } from '@/lib/nebula/drift'
import { runVersionCheck } from './version-check'
import { runNodeCertChecks } from './node-cert-check'
import { globalSingleton } from '@/lib/global-state'
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks'

// Shared across all module chunks in the process (see global-state.ts). A plain
// module-level `let`/`Map` would be duplicated in Next.js standalone builds,
// breaking the poll mutex and cron `started` guard.
const workerState = globalSingleton('__piholeCentralWorkerState', () => ({
  isRunning: false,
  lastPollAt: 0,
  lastPollStartedAt: 0,
  lastStatsAt: 0,
  cronStarted: false,
  topDataCache: new Map<string, { topDomains: TopDomain[]; topClients: TopClient[] }>(),
  loopDelay: null as IntervalHistogram | null,
}))

// If the app's own event loop stalls this long, its HTTP timeouts are not
// evidence about the nodes (P5.5 / R2-NV4): alert, don't restart anything.
const EVENT_LOOP_STALL_MS = 2_000

/** Worst event-loop delay since the previous poll, in ms (and reset the window). */
function takeEventLoopStallMs(): number {
  if (!workerState.loopDelay) {
    workerState.loopDelay = monitorEventLoopDelay({ resolution: 50 })
    workerState.loopDelay.enable()
    return 0
  }
  const maxMs = workerState.loopDelay.max / 1e6
  workerState.loopDelay.reset()
  return Number.isFinite(maxMs) ? maxMs : 0
}

async function getPollIntervalMs(): Promise<number> {
  const setting = await db.query.appSettings.findFirst({
    where: eq(appSettings.key, 'poll_interval_seconds'),
  })
  const seconds = parseInt(setting?.value ?? '300', 10)
  return Math.max(60, Math.min(3600, seconds)) * 1000
}

async function getStatsIntervalMs(): Promise<number> {
  const setting = await db.query.appSettings.findFirst({
    where: eq(appSettings.key, 'stats_interval_seconds'),
  })
  const seconds = parseInt(setting?.value ?? '300', 10)
  return Math.max(60, Math.min(3600, seconds)) * 1000
}

const POLL_RETRY_DELAY_MS = 5_000
const POLL_TICK_SLACK_MS = 5_000

/**
 * getSummary with one retry. The nodes are on Wi-Fi and the logs show short
 * bursts of timeouts (2026-10-30, 2026-11-05) that also hit plain HTTP — a
 * single miss shouldn't write an offline snapshot and start SSH recovery.
 */
async function getSummaryWithRetry(instanceId: string) {
  try {
    return await piholeClient.getSummary(instanceId)
  } catch {
    await new Promise((r) => setTimeout(r, POLL_RETRY_DELAY_MS))
    return await piholeClient.getSummary(instanceId)
  }
}

async function handleOnline(
  instance: typeof instances.$inferSelect,
  summary: PiHoleSummary,
  shouldFetchStats: boolean
): Promise<void> {
  if (shouldFetchStats) {
    try {
      const [topDomains, topClients] = await Promise.all([
        piholeClient.getTopDomains(instance.id, 10),
        piholeClient.getTopClients(instance.id, 10),
      ])
      workerState.topDataCache.set(instance.id, { topDomains, topClients })
    } catch (err) {
      console.error(`[poller] Top data unavailable for ${instance.name}: ${errMsg(err)}`)
    }
  }

  const { topDomains = [], topClients = [] } = workerState.topDataCache.get(instance.id) ?? {}

  await db.insert(statsSnapshots).values({
    instanceId: instance.id,
    timestamp: new Date(),
    queriesToday: summary.queries.total,
    blockedToday: summary.queries.blocked,
    blockPct: summary.queries.percent_blocked,
    uniqueDomains: summary.queries.unique_domains,
    topDomainsJson: JSON.stringify(topDomains),
    topClientsJson: JSON.stringify(topClients),
    status: 'online',
  })

  if (instance.sshUsername) {
    // Both catch internally and log; these are belt-and-braces.
    runWatchdogCheck(instance).catch((err) =>
      console.error(`[watchdog] Check failed for ${instance.name}: ${errMsg(err)}`)
    )
    // Self-gated SSH health sweep (disk/SD, DoT cert expiry, latency).
    runHealthChecks(instance).catch((err) =>
      console.error(`[health] Check failed for ${instance.name}: ${errMsg(err)}`)
    )
  }

  // Only clear recovery state if a recovery isn't still mid-flight —
  // recovery spans multiple poll cycles (restart + 30s waits), and a
  // transient online blip must not orphan the in-flight state object and
  // let a second concurrent recovery start from attempts=0.
  if (!isRecoveryActive(instance.id)) clearRecoveryState(instance.id)

  // Resolve the offline condition, whichever path raised it (plain offline,
  // SSH unreachable, unrecoverable, poll failing). 'resolved' happens exactly
  // once per raise, so "Recovered" pairs with every offline alert and never
  // fires without one.
  const transition = await notifyCondition({
    type: 'offline',
    severity: 'info',
    title: `Pi-Hole Offline: ${instance.name}`,
    instanceId: instance.id,
    active: false,
  })
  if (transition === 'resolved') {
    await notify({
      type: 'recovery',
      severity: 'info',
      title: `Pi-Hole Recovered: ${instance.name}`,
      message: `${instance.name} (${instance.url}) is back online.`,
      instanceId: instance.id,
    })
  }

  await checkAlerts(instance, summary, 'online')
}

async function handleOffline(
  instance: typeof instances.$inferSelect,
  err: unknown,
  appSideReason: string | null = null
): Promise<void> {
  console.error(`[poller] Failed to poll ${instance.name}: ${errMsg(err)}`)
  await db.insert(statsSnapshots).values({
    instanceId: instance.id,
    timestamp: new Date(),
    queriesToday: 0,
    blockedToday: 0,
    blockPct: 0,
    uniqueDomains: 0,
    topDomainsJson: '[]',
    topClientsJson: '[]',
    status: 'offline',
  })

  // Common-mode failure (every node at once, or the app itself stalled): the
  // likeliest fault is on the app's side or the network, and restarting or
  // rebooting the Pi-holes would only take DNS away. Alert only (P5.5).
  if (appSideReason) {
    await db.insert(recoveryEvents).values({
      instanceId: instance.id,
      timestamp: new Date(),
      eventType: 'recovery_skipped',
      detail: `Not recovering: ${appSideReason}`,
      success: false,
    })
    await raiseOffline(
      instance,
      'critical',
      'Unreachable From App',
      `${instance.name} (${instance.url}) is not answering the app, but automatic recovery is paused because ${appSideReason}. Check the app host and the network before touching the nodes.`
    )
    return
  }

  // With SSH configured, recovery owns the outage and raises the offline
  // condition itself only if it can't fix it — a node that an FTL restart
  // brings back in 30s shouldn't page. Without SSH, raise it straight away.
  const handledByRecovery = await runRecovery(instance).catch((e) => {
    console.error(`[poller] Recovery initiation error for ${instance.name}: ${errMsg(e)}`)
    return false
  })
  if (!handledByRecovery) {
    await raiseOffline(instance, 'critical', null, `${instance.name} (${instance.url}) is not responding.`)
  }
}

export async function pollAllInstances() {
  if (workerState.isRunning) return
  workerState.isRunning = true

  // Everything after taking the mutex is inside the try, so the finally always
  // releases it. A DB read used to sit between the two, and a single throw
  // there left isRunning=true forever: no polling, alerts or recovery until
  // the container restarted.
  workerState.lastPollStartedAt = Date.now()
  try {
    const now = Date.now()
    const statsIntervalMs = await getStatsIntervalMs()
    const shouldFetchStats = (now - workerState.lastStatsAt) >= statsIntervalMs

    const activeInstances = await db.query.instances.findMany({
      where: eq(instances.enabled, true),
    })

    // Poll every node first, then act: recovery needs to know whether ALL of
    // them failed together (P5.5 common-mode guard).
    // Only a failed summary fetch means "offline". Errors in the processing
    // that follows (DB insert, alert checks) used to land in the same catch,
    // writing an offline snapshot for a healthy node and SSHing in to
    // "recover" it.
    const stallMs = takeEventLoopStallMs()
    const results: { instance: (typeof activeInstances)[number]; summary?: PiHoleSummary; err?: unknown }[] = []
    for (const instance of activeInstances) {
      try {
        results.push({ instance, summary: await getSummaryWithRetry(instance.id) })
      } catch (err) {
        results.push({ instance, err })
      }
    }
    const failed = results.filter((r) => !r.summary).length
    const appSideReason =
      stallMs >= EVENT_LOOP_STALL_MS
        ? `the app's own event loop stalled for ${Math.round(stallMs)} ms since the last poll`
        : results.length >= 2 && failed === results.length
          ? `all ${results.length} Pi-hole nodes failed at the same time`
          : null

    for (const r of results) {
      if (!r.summary) {
        await handleOffline(r.instance, r.err, appSideReason).catch((e) =>
          console.error(`[poller] Offline handling failed for ${r.instance.name}: ${errMsg(e)}`)
        )
        continue
      }
      await handleOnline(r.instance, r.summary, shouldFetchStats).catch((e) =>
        console.error(`[poller] Post-poll processing failed for ${r.instance.name}: ${errMsg(e)}`)
      )
    }

    if (shouldFetchStats) workerState.lastStatsAt = now

    // Prune old rows based on the configurable retention setting. recovery_events
    // is pruned on the same window — it was previously never pruned and grew
    // unbounded (thousands of rows on a flapping node).
    const retSetting = await db.query.appSettings.findFirst({
      where: eq(appSettings.key, 'retention_days'),
    })
    const retentionDays = parseInt(retSetting?.value ?? '30', 10)
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000)
    await db.delete(statsSnapshots).where(lt(statsSnapshots.timestamp, cutoff))
    await db.delete(recoveryEvents).where(lt(recoveryEvents.timestamp, cutoff))
    // Never prune a LIVE condition row: an ongoing problem older than the
    // retention window would silently vanish from the bell.
    await db.delete(notifications).where(
      and(lt(notifications.timestamp, cutoff), or(eq(notifications.sticky, false), isNotNull(notifications.resolvedAt)))
    )
    const auditRet = await db.query.appSettings.findFirst({
      where: eq(appSettings.key, 'audit_retention_days'),
    })
    const auditDays = Math.max(
      AUDIT_RETENTION_MIN,
      parseInt(auditRet?.value ?? String(AUDIT_RETENTION_DEFAULT), 10) || AUDIT_RETENTION_DEFAULT
    )
    await db.delete(auditLog).where(lt(auditLog.timestamp, new Date(Date.now() - auditDays * 24 * 60 * 60 * 1000)))

    await runVersionCheck().catch((err) => console.error(`[poller] Version check error: ${errMsg(err)}`))
    // Daily per node, one TLS handshake each; https nodes only.
    await runNodeCertChecks().catch((err) => console.error(`[poller] Node cert check error: ${errMsg(err)}`))
    // Not awaited: a Teleporter export with retries can take minutes on the Pi
    // Zero and must not hold the poll mutex (it delayed health polling and
    // recovery). runScheduledBackups has its own running guard.
    void runScheduledBackups().catch((err) => console.error(`[poller] Scheduled backup error: ${errMsg(err)}`))
    await runNebulaDriftCheck().catch((err) => console.error(`[poller] Nebula drift check error: ${errMsg(err)}`))
    await runHostDiskCheck() // self-throttled to the health interval; never throws
  } finally {
    workerState.isRunning = false
    workerState.lastPollAt = Date.now()
  }
}

export function startPolling() {
  if (workerState.cronStarted) return
  workerState.cronStarted = true
  console.log('[poller] Starting background polling (configurable interval, checked every minute)')
  pollAllInstances().catch((err) => console.error(`[poller] ${errMsg(err)}`))
  cron.schedule('* * * * *', async () => {
    // DNS schedules + temp-allow reverts are time-window based, so they run every
    // minute regardless of the (longer) stats poll interval.
    runScheduledProfiles().catch((err) => console.error(`[scheduler] profiles: ${errMsg(err)}`))
    runTempAllowRevert().catch((err) => console.error(`[scheduler] temp-allow: ${errMsg(err)}`))

    try {
      const intervalMs = await getPollIntervalMs()
      // Measure from when the last poll STARTED, with a little slack. The cron
      // ticks exactly on the minute and a poll takes a few seconds, so
      // "since it finished" always came out at ~59s for a 60s interval and
      // every other tick was skipped — a 60s setting actually polled every 2
      // minutes (the live DB had 30 snapshots/hour per node, not 60).
      if (Date.now() - workerState.lastPollStartedAt >= intervalMs - POLL_TICK_SLACK_MS) {
        pollAllInstances().catch((err) => console.error(`[poller] ${errMsg(err)}`))
      }
    } catch (err) {
      console.error(`[poller] Could not read poll interval: ${errMsg(err)}`)
    }
  })
}
