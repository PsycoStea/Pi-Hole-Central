import { db } from '@/lib/db'
import { eq, sql } from 'drizzle-orm'
import { instances, recoveryEvents, recoveryState as recoveryStateTable } from '@/lib/db/schema'
import { HostKeyMismatchError } from '@/lib/ssh/host-keys'
import { connectSSH, extractHost, isFTLRunning, restartFTL, rebootDevice, nodeLocalCheck, type NodeLocalStatus } from './client'
import { acquireNodeLock, getActiveNodeLock, releaseNodeLock, renewNodeLock, LOCK_LABEL, type NodeLock } from '@/lib/ops/node-lock'
import { scaled } from '@/lib/ops/time-scale'
import { notify, notifyCondition, getConditionSeverity, type Severity } from '@/lib/notifications/center'
import { globalSingleton } from '@/lib/global-state'
import { errMsg } from '@/lib/errors'
import { nodeFetch, isNodeAnsweringError } from '@/lib/pihole/transport'

type RecoveryState = {
  attempts: number
  // Consecutive polls where FTL is running but the REST API is still down
  // (the CLOSE-WAIT / civetweb-wedged failure mode). Escalates to a restart.
  autoRecoveredCount: number
  // Consecutive polls where the API answers an unauthenticated probe but the
  // app's authenticated poll still fails (wrong app password, session seats
  // exhausted). FTL is alive in that case, so restarting it would not help.
  apiUpFailures: number
  rebooted: boolean
  rebootedAt: number
  inProgress: boolean
  // Terminal: still offline after a reboot. Nothing more is attempted until a
  // successful poll clears the state.
  manualRequired: boolean
  // While SSH is unreachable, don't try again before this time (ms epoch).
  sshRetryAt: number
  // Consecutive recoveries where the node answered on its own loopback while the
  // app could not reach it: the problem is on the app side or the path (P5.5).
  appSideFailures: number
  // Set by clearRecoveryState (instance disabled/deleted) while a loop is in
  // flight: the loop stops at its next checkpoint (P5.3). Never persisted.
  cancelled: boolean
}

// What survives an app restart (P5.4): everything except the live-loop flags.
type PersistedState = Omit<RecoveryState, 'inProgress' | 'cancelled'>

// Anchored on globalThis so all Next.js standalone chunks share one map — a
// duplicated map would let the inProgress guard miss and start concurrent
// recovery loops (restart storms) on the same node.
const recoveryState = globalSingleton(
  '__piholeCentralRecoveryState',
  () => new Map<string, RecoveryState>()
)

export function getRecoveryState(instanceId: string): RecoveryState | undefined {
  return recoveryState.get(instanceId)
}

export function isRecoveryActive(instanceId: string): boolean {
  return recoveryState.get(instanceId)?.inProgress === true
}

/**
 * Forget a node's recovery state: on a successful poll, and when the instance
 * is disabled or deleted.
 *
 * A loop that is still running is CANCELLED, not orphaned (P5.3 / R2-F7):
 * deleting its map entry used to leave the detached loop restarting FTL and
 * rebooting a node the operator had just switched off, and dropped the
 * single-loop guard so a re-enable started a second loop. The entry now stays
 * (so runRecovery still sees inProgress) until the loop exits at its next
 * checkpoint and removes it.
 *
 * The persisted budget is cleared too, except last_reboot_at: that is the
 * 1-reboot-per-24h limit and must outlive a single outage.
 */
export function clearRecoveryState(instanceId: string): void {
  const live = recoveryState.get(instanceId)
  if (live?.inProgress) live.cancelled = true
  else recoveryState.delete(instanceId)
  db.run(sql`UPDATE recovery_state SET state_json = NULL, updated_at = ${Date.now()}
             WHERE instance_id = ${instanceId} AND state_json IS NOT NULL`)
}

function freshState(): RecoveryState {
  return {
    attempts: 0,
    autoRecoveredCount: 0,
    apiUpFailures: 0,
    rebooted: false,
    rebootedAt: 0,
    inProgress: false,
    manualRequired: false,
    sshRetryAt: 0,
    appSideFailures: 0,
    cancelled: false,
  }
}

/**
 * The node's state, rebuilt from the DB after an app restart (P5.4 / R2-F8).
 * The restart budget, boot grace and the manual_required STOP latch used to
 * live only in this Map, so every deploy or container restart re-armed a full
 * restart x3 + reboot lap on a node the app had already given up on.
 */
async function loadState(instanceId: string): Promise<RecoveryState | undefined> {
  const live = recoveryState.get(instanceId)
  if (live) return live
  const row = await db.query.recoveryState.findFirst({ where: eq(recoveryStateTable.instanceId, instanceId) })
  if (!row?.stateJson) return undefined
  try {
    const saved = JSON.parse(row.stateJson) as Partial<PersistedState>
    const state: RecoveryState = { ...freshState(), ...saved, inProgress: false, cancelled: false }
    recoveryState.set(instanceId, state)
    return state
  } catch {
    return undefined
  }
}

async function saveState(instanceId: string, state: RecoveryState): Promise<void> {
  const { inProgress: _ip, cancelled: _c, ...persisted } = state
  void _ip
  void _c
  const json = JSON.stringify(persisted satisfies PersistedState)
  const now = Date.now()
  await db
    .insert(recoveryStateTable)
    .values({ instanceId, stateJson: json, updatedAt: now })
    .onConflictDoUpdate({ target: recoveryStateTable.instanceId, set: { stateJson: json, updatedAt: now } })
    .catch((err) => console.error(`[recovery] could not persist state: ${errMsg(err)}`))
}

async function lastAutomaticReboot(instanceId: string): Promise<number> {
  const row = await db.query.recoveryState.findFirst({ where: eq(recoveryStateTable.instanceId, instanceId) })
  return row?.lastRebootAt ?? 0
}

async function recordReboot(instanceId: string): Promise<void> {
  const now = Date.now()
  await db
    .insert(recoveryStateTable)
    .values({ instanceId, lastRebootAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: recoveryStateTable.instanceId, set: { lastRebootAt: now, updatedAt: now } })
}

type InstanceRef = {
  id: string
  name: string
  url: string
  sshUsername: string | null
  sshPasswordEncrypted: string | null
}

async function logEvent(
  instanceId: string,
  eventType: string,
  detail: string,
  success: boolean
): Promise<void> {
  // A deleted instance fails the FK; that must not crash a cancelling loop.
  await db
    .insert(recoveryEvents)
    .values({ instanceId, timestamp: new Date(), eventType, detail, success })
    .catch((err) => console.error(`[recovery] could not log ${eventType}: ${errMsg(err)}`))
}

/**
 * Raise (or update) the instance's single live "offline" condition.
 *
 * Offline is a STATE, so it goes through notifyCondition: one live row per
 * instance, resolved by the poller on the next successful poll (which is also
 * what emits the paired "Recovered" event). It used to be a one-shot notify()
 * from here, which nothing could ever resolve — an "SSH Unreachable" alert
 * stayed critical forever after a few-second blip.
 *
 * The reason goes in the TITLE so a change of reason (unreachable ->
 * unrecoverable) resurfaces the row and re-pushes.
 */
export async function raiseOffline(
  instance: Pick<InstanceRef, 'id' | 'name' | 'url'>,
  severity: Severity,
  reason: string | null,
  message: string
): Promise<void> {
  await notifyCondition({
    type: 'offline',
    severity,
    title: reason ? `Pi-Hole ${reason}: ${instance.name}` : `Pi-Hole Offline: ${instance.name}`,
    message,
    instanceId: instance.id,
    active: true,
  })
}

const RESTART_WAIT_MS = 30_000
const MAX_RESTART_ATTEMPTS = 3
// At most one automatic reboot per node per day (P5.4); after that, alert only.
const REBOOT_BUDGET_WINDOW_MS = 24 * 60 * 60_000
// Recoveries in a row where the node answered on its own loopback but not to
// the app before the app-side condition is raised (P5.5).
const APP_SIDE_ALERT = 3
// After this many consecutive polls where FTL is up but the API is still down,
// stop assuming "needs a moment" and force a restart to clear the wedged API.
const AUTO_RECOVERED_ESCALATE = 3
// Polls in a row where the API answers but the app's poll fails before we
// call it out. Below this it is treated as a transient blip.
const API_UP_FAILURES_ALERT = 3
// A Pi Zero 2W takes a couple of minutes to boot and start FTL; judging it
// "unrecoverable" on the very next 60s poll after `sudo reboot` was premature.
const BOOT_GRACE_MS = 5 * 60_000
// While SSH is unreachable, retry this often instead of giving up for the
// rest of the outage.
const SSH_RETRY_MS = 10 * 60_000

/**
 * Unauthenticated liveness probe. 200 or 401 both prove the HTTP API is
 * answering (401 just means "log in first"); a timeout or 5xx means it isn't.
 */
async function checkApiReachable(instance: InstanceRef): Promise<boolean> {
  try {
    // nodeFetch: CA-verified https, never follows a redirect (a 3xx throws -> unreachable)
    const res = await nodeFetch(`${instance.url}/api/stats/summary`, {
      signal: AbortSignal.timeout(5_000),
    })
    await res.body?.cancel().catch(() => {})
    return res.ok || res.status === 401
  } catch (err) {
    // A redirect, a certificate that does not verify, or our own missing CA
    // file all mean the node is there; an FTL restart cannot fix them.
    return isNodeAnsweringError(err)
  }
}

/** After a restart, give the API a few chances to come back before trusting it. */
async function waitForApi(instance: InstanceRef, tries = 3, gapMs = scaled(10_000)): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if (await checkApiReachable(instance)) return true
    if (i < tries - 1) await new Promise((r) => setTimeout(r, gapMs))
  }
  return false
}

// Per node: the lock we last logged a "skipped, node busy" event for, so a
// 15-minute update logs one line, not one per poll.
const skipLogged = globalSingleton('__piholeCentralRecoverySkipLogged', () => new Map<string, number>())

/**
 * Entry point called from worker.ts when an instance's poll fails.
 * Non-blocking: the async recovery work is fired without being awaited.
 * Returns true if recovery owns this outage (the caller must not raise its own
 * offline alert); false if SSH is not configured for this instance.
 */
export async function runRecovery(instance: InstanceRef): Promise<boolean> {
  if (!instance.sshUsername) return false

  const existing = await loadState(instance.id)

  if (existing?.inProgress) return true
  if (existing?.manualRequired) return true
  if (existing && existing.sshRetryAt > Date.now()) return true

  // An update, gravity run or Teleporter export owns the node right now: its
  // API going down is expected, so neither recover nor page (P5.2 / R2-NV3).
  // The lock expires on its own, so a hung operation hands the node back.
  const held = await getActiveNodeLock(instance.id)
  if (held && held.kind !== 'recovery') {
    if (skipLogged.get(instance.id) !== held.startedAt) {
      skipLogged.set(instance.id, held.startedAt)
      await logEvent(instance.id, 'recovery_skipped', `Node is busy with ${LOCK_LABEL[held.kind]}; not recovering while it runs`, true)
    }
    return true
  }

  if (existing?.rebooted) {
    if (Date.now() - existing.rebootedAt < scaled(BOOT_GRACE_MS)) return true
    // Still offline well after a reboot — escalate to manual intervention and
    // STOP. Deleting the state here (as before) made the next poll start a
    // fresh recovery from attempts=0: restart x3, reboot, "Unrecoverable",
    // forever, with a critical push every lap.
    await logEvent(
      instance.id,
      'manual_required',
      'Still offline after automatic reboot. Manual intervention required.',
      false
    )
    await raiseOffline(
      instance,
      'critical',
      'Unrecoverable',
      `${instance.name} (${instance.url}) is still offline after an automatic reboot. Manual intervention required.`
    )
    existing.manualRequired = true
    await saveState(instance.id, existing)
    return true
  }

  const state: RecoveryState = {
    ...freshState(),
    attempts: existing?.attempts ?? 0,
    autoRecoveredCount: existing?.autoRecoveredCount ?? 0,
    apiUpFailures: existing?.apiUpFailures ?? 0,
    appSideFailures: existing?.appSideFailures ?? 0,
    inProgress: true,
  }
  recoveryState.set(instance.id, state)

  _runRecoveryAsync(instance, state)
    .catch((err) => console.error(`[recovery] Unexpected error for ${instance.name}: ${errMsg(err)}`))
    .finally(() => {
      state.inProgress = false
      // Remove the entry only if it is still ours (a cancelled loop), never a newer loop's.
      if (state.cancelled && recoveryState.get(instance.id) === state) recoveryState.delete(instance.id)
    })

  return true
}

class Cancelled extends Error {}

/**
 * P5.3: stop before any further action if the operator disabled or deleted the
 * node, or changed its address or SSH login, since the loop started.
 */
async function checkpoint(instance: InstanceRef, state: RecoveryState, lock: NodeLock | null): Promise<void> {
  if (state.cancelled) throw new Cancelled('instance disabled or removed')
  const row = await db.query.instances.findFirst({ where: eq(instances.id, instance.id) })
  if (!row) throw new Cancelled('instance deleted')
  if (!row.enabled) throw new Cancelled('instance disabled')
  if (row.url !== instance.url || row.sshUsername !== instance.sshUsername) {
    throw new Cancelled('instance address or SSH login changed')
  }
  if (lock && !(await renewNodeLock(lock))) throw new Cancelled('lost the node lock')
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function _runRecoveryAsync(instance: InstanceRef, state: RecoveryState): Promise<void> {
  let lock: NodeLock | null = null
  let ssh = null
  try {
    // First ask whether FTL is actually down. Any getSummary failure used to be
    // treated as an FTL outage, so a wrong app password (401) or exhausted
    // session seats (429) led to FTL restarts and eventually a reboot of a
    // perfectly healthy node.
    if (await checkApiReachable(instance)) {
      state.apiUpFailures++
      await logEvent(
        instance.id,
        'api_reachable',
        `Pi-hole API answers but the authenticated poll failed (${state.apiUpFailures}/${API_UP_FAILURES_ALERT}) — not restarting FTL`,
        false
      )
      if (state.apiUpFailures >= API_UP_FAILURES_ALERT) {
        await raiseOffline(
          instance,
          'warning',
          'Poll Failing',
          `${instance.name} (${instance.url}) answers HTTP but the app's authenticated requests keep failing. Check the instance's app password, or whether the node's API session limit is exhausted.`
        )
      }
      return
    }
    state.apiUpFailures = 0

    // One node at a time, and never while another operation holds this node
    // (P5.2, P5.5). The acquire is atomic, so the other node's recovery or
    // watchdog restart in the same poll sweep cannot slip in alongside.
    lock = await acquireNodeLock(instance.id, 'recovery')
    if (!lock) {
      await logEvent(instance.id, 'recovery_deferred', 'Another node is being restarted, or this node is busy — deferring recovery to the next poll', false)
      await raiseOffline(
        instance,
        'critical',
        'Offline — Recovery Deferred',
        `${instance.name} (${instance.url}) is not responding. Automatic recovery is waiting: the other node is being restarted or this node is busy, and the app never acts on both at once.`
      )
      return
    }

    const host = extractHost(instance.url)
    try {
      ssh = await connectSSH({
        host,
        username: instance.sshUsername!,
        passwordEncrypted: instance.sshPasswordEncrypted,
      })
    } catch (err) {
      // API is down (checked above) and SSH can't connect either. Raise the
      // condition and retry SSH later rather than giving up for the rest of
      // the outage — one handshake timeout during a real FTL wedge used to
      // disable auto-recovery until the node came back on its own.
      await logEvent(
        instance.id,
        'ssh_failed',
        `SSH and Pi-Hole API both unreachable (${errMsg(err)}) — retrying SSH in ${SSH_RETRY_MS / 60_000} min`,
        false
      )
      // A changed host key is refused on purpose: say so, rather than "unreachable"
      // (the ssh_host_key alert carries the fingerprints and how to clear it).
      const keyChanged = err instanceof HostKeyMismatchError || /SSH host key for/.test(errMsg(err))
      await raiseOffline(
        instance,
        'critical',
        keyChanged ? 'Offline — SSH Host Key Changed' : 'Offline — SSH Unreachable',
        keyChanged
          ? `${instance.name} (${instance.url}) is offline and SSH recovery refused to connect because the node's host key changed. See the "SSH host key changed" alert.`
          : `${instance.name} (${instance.url}) is offline and SSH recovery cannot connect. Retrying every ${SSH_RETRY_MS / 60_000} minutes.`
      )
      state.sshRetryAt = Date.now() + scaled(SSH_RETRY_MS)
      return
    }

    // P5.5 / R2-NV4: ask the node itself before doing anything to it. If FTL's
    // API answers on the node's own loopback, the failure is between the app
    // and the node (app stall, network path), and restarting FTL would only
    // take DNS down for nothing. Only a positive "no answer" lets us act.
    const local = await nodeLocalCheck(ssh)
    if (local.api !== 'down') {
      state.appSideFailures++
      await logEvent(
        instance.id,
        'node_local_ok',
        `The node answers on its own loopback (${local.detail}) but not to the app (${state.appSideFailures}/${APP_SIDE_ALERT}) — not restarting FTL`,
        false
      )
      if (state.appSideFailures >= APP_SIDE_ALERT) {
        await raiseOffline(
          instance,
          'warning',
          'Unreachable From App',
          `${instance.name} (${instance.url}) answers on the node itself (${local.detail}) but the app cannot reach it. Check the network path, the app host, and the node's https certificate.`
        )
      }
      return
    }
    state.appSideFailures = 0

    // FTL may have self-recovered before we got here, or the process is up but
    // the REST API is wedged (CLOSE-WAIT / civetweb spin). Give it a few cycles
    // to settle, then escalate to a restart instead of looping "auto_recovered"
    // forever (this loop previously produced thousands of no-op events).
    const alreadyRunning = await isFTLRunning(ssh)
    if (alreadyRunning) {
      state.autoRecoveredCount++
      if (state.autoRecoveredCount < AUTO_RECOVERED_ESCALATE) {
        await logEvent(
          instance.id,
          'auto_recovered',
          `pihole-FTL is running; REST API may need a moment (${state.autoRecoveredCount}/${AUTO_RECOVERED_ESCALATE}; ${local.detail})`,
          true
        )
        return
      }
      await logEvent(
        instance.id,
        'service_restart_attempt',
        `pihole-FTL is running but the REST API stayed down for ${state.autoRecoveredCount} cycles (${local.detail}) — restarting to clear a wedged API`,
        true
      )
      state.autoRecoveredCount = 0
      // fall through to the restart loop
    }

    let lastLocal: NodeLocalStatus = local
    while (state.attempts < MAX_RESTART_ATTEMPTS) {
      await checkpoint(instance, state, lock)
      state.attempts++
      await saveState(instance.id, state)
      await logEvent(
        instance.id,
        'service_restart_attempt',
        `Restart attempt ${state.attempts} of ${MAX_RESTART_ATTEMPTS}`,
        true
      )

      const exitCode = await restartFTL(ssh)
      if (exitCode !== 0) {
        await logEvent(
          instance.id,
          'service_restart_failed',
          `systemctl restart exited with code ${exitCode}`,
          false
        )
      }

      await sleep(scaled(RESTART_WAIT_MS))
      await checkpoint(instance, state, lock)

      // "systemctl is-active" alone is not recovery: in the wedged-API failure
      // mode FTL reports active while the API is still dead, which used to
      // send a false "Auto-Recovered" and then fail again on the next poll.
      const running = await isFTLRunning(ssh)
      const apiBack = running && (await waitForApi(instance))
      if (apiBack) {
        await logEvent(
          instance.id,
          'service_restart_success',
          `pihole-FTL recovered after restart attempt ${state.attempts}`,
          true
        )
        // If an offline condition is already live (e.g. SSH was unreachable
        // earlier), the poller's resolve will emit "Recovered" — don't
        // double up with "Auto-Recovered".
        if ((await getConditionSeverity('offline', instance.id)) === null) {
          await notify({
            type: 'recovery',
            severity: 'info',
            title: `Pi-Hole Auto-Recovered: ${instance.name}`,
            message: `${instance.name} (${instance.url}) was automatically recovered by restarting pihole-FTL (attempt ${state.attempts} of ${MAX_RESTART_ATTEMPTS}).`,
            instanceId: instance.id,
          })
        }
        return
      }
      // The app still can't reach it. If the node now answers locally, the
      // restart worked and the problem is on the app's side: stop here
      // rather than restarting again and then rebooting a healthy node.
      lastLocal = await nodeLocalCheck(ssh)
      if (lastLocal.api !== 'down') {
        await logEvent(
          instance.id,
          'node_local_ok',
          `After restart ${state.attempts} the node answers locally (${lastLocal.detail}) but not to the app — no further restarts`,
          false
        )
        await raiseOffline(
          instance,
          'warning',
          'Unreachable From App',
          `${instance.name} (${instance.url}) came back on the node itself after an FTL restart (${lastLocal.detail}) but the app still cannot reach it. Check the network path and the app host.`
        )
        return
      }
      if (running) {
        await logEvent(
          instance.id,
          'service_restart_failed',
          `pihole-FTL is active after attempt ${state.attempts} but the API still isn't answering (${lastLocal.detail})`,
          false
        )
      }
    }

    // All restart attempts failed. Reboot only if that can't make things
    // worse: the node's own DNS must be down too (a reboot of a node whose DNS
    // still answers takes DNS away to fix only the web UI), and at most one
    // automatic reboot per node per day (P5.4).
    await checkpoint(instance, state, lock)
    const finalLocal = await nodeLocalCheck(ssh)
    const lastReboot = await lastAutomaticReboot(instance.id)
    const budgetUsed = Date.now() - lastReboot < scaled(REBOOT_BUDGET_WINDOW_MS)
    if (finalLocal.api !== 'down' || finalLocal.dns !== 'down' || budgetUsed) {
      const why =
        finalLocal.api !== 'down'
          ? `the node answers locally now (${finalLocal.detail})`
          : finalLocal.dns !== 'down'
            ? `its DNS still answers (${finalLocal.detail}), so a reboot would cost DNS to fix only the API`
            : `it was already rebooted automatically at ${new Date(lastReboot).toISOString()} (limit: one per 24 h)`
      await logEvent(instance.id, 'manual_required', `All ${MAX_RESTART_ATTEMPTS} restarts failed; not rebooting because ${why}.`, false)
      await raiseOffline(
        instance,
        'critical',
        'Unrecoverable',
        `${instance.name} (${instance.url}): ${MAX_RESTART_ATTEMPTS} automatic FTL restarts did not bring the API back, and the app will not reboot it because ${why}. Manual intervention required.`
      )
      state.manualRequired = true
      return
    }
    await logEvent(
      instance.id,
      'device_reboot',
      `All ${MAX_RESTART_ATTEMPTS} restart attempts failed and the node's API and DNS are both down locally. Sending reboot command.`,
      true
    )
    await recordReboot(instance.id)
    await rebootDevice(ssh)
    state.rebooted = true
    state.rebootedAt = Date.now()
    // After BOOT_GRACE_MS, runRecovery escalates to manual_required if the
    // node is still offline.
  } catch (err) {
    if (!(err instanceof Cancelled)) throw err
    await logEvent(instance.id, 'recovery_cancelled', `Recovery stopped: ${err.message}`, true)
  } finally {
    if (ssh) ssh.dispose()
    await releaseNodeLock(lock)
    state.inProgress = false
    if (!state.cancelled) await saveState(instance.id, state)
  }
}
