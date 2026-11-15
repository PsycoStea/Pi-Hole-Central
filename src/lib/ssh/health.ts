import { db } from '@/lib/db'
import { appSettings } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { connectSSH, extractHost } from './client'
import { getForwardConfig, testDotHealth } from './unbound'
import { notifyCondition, getConditionSeverity, type Severity } from '@/lib/notifications/center'
import { globalSingleton } from '@/lib/global-state'
import { errMsg } from '@/lib/errors'
import type { NodeSSH } from 'node-ssh'

type InstanceRef = {
  id: string
  name: string
  url: string
  sshUsername: string | null
  sshPasswordEncrypted: string | null
}

// Thresholds (defaults; overridable via app_settings keys where noted).
const SD_WARN_PCT = 80
const SD_CRIT_PCT = 90
const CERT_WARN_DAYS = 14
const CERT_CRIT_DAYS = 3
const LATENCY_WARN_MS = 150
const LATENCY_CRIT_MS = 500

// Hysteresis floors: once raised, a condition stays raised until the metric drops
// past these (below the raise thresholds above), so a value hovering at the line
// doesn't alternate raised/cleared on every sweep.
const SD_CLEAR_PCT = 78
const LATENCY_CLEAR_MS = 120

// How often the (relatively expensive) SSH health sweep runs per instance.
const DEFAULT_HEALTH_INTERVAL_MS = 15 * 60 * 1000

const healthState = globalSingleton('__piholeCentralHealthState', () => ({
  lastRun: new Map<string, number>(), // instanceId -> ts
}))

/**
 * Resolve the severity to report, applying hysteresis.
 *
 * `sev` is the severity the metric warrants right now (null = below all raise
 * thresholds). When it has fallen below the raise threshold but is still inside
 * the hysteresis band, hold the severity already on the live condition instead
 * of resolving — otherwise a metric hovering at its threshold would resolve and
 * re-raise on every sweep.
 *
 * `liveSeverity` comes from the database (the live sticky row), so the band
 * behaves correctly across restarts.
 */
export function severityWithHysteresis(
  sev: Severity | null,
  liveSeverity: Severity | null,
  inHysteresisBand: boolean
): Severity | null {
  if (sev !== null) return sev
  return inHysteresisBand ? liveSeverity : null
}

async function getHealthIntervalMs(): Promise<number> {
  const s = await db.query.appSettings.findFirst({
    where: eq(appSettings.key, 'health_check_interval_seconds'),
  })
  const seconds = parseInt(s?.value ?? '', 10)
  return Number.isFinite(seconds) && seconds >= 60 ? seconds * 1000 : DEFAULT_HEALTH_INTERVAL_MS
}

// ---- Individual checks -----------------------------------------------------

// usedPct is null when df output couldn't be parsed. That is "no reading",
// not "0% used" — reporting 0 used to resolve a live critical disk alert
// exactly when the node was struggling hardest.
export type DiskHealth = { usedPct: number | null; readOnly: boolean }

export async function getDiskHealth(ssh: NodeSSH): Promise<DiskHealth> {
  // Root filesystem usage %. No sudo required.
  const df = await ssh.execCommand("df -Pk / | awk 'NR==2 {print $5}'")
  const usedPct = parseInt(df.stdout.trim().replace('%', ''), 10)
  // Detect a read-only remount of / — the classic SD-card-failure symptom.
  const mounts = await ssh.execCommand("awk '$2==\"/\"{print $4}' /proc/mounts")
  const readOnly = /(^|,)ro(,|$)/.test(mounts.stdout.trim())
  return { usedPct: Number.isFinite(usedPct) ? usedPct : null, readOnly }
}

export type CertResult = { host: string; daysLeft: number }

export async function checkCertExpiry(ssh: NodeSSH): Promise<CertResult[]> {
  const { forwardAddrs } = await getForwardConfig(ssh)
  const out: CertResult[] = []
  for (const addr of forwardAddrs) {
    // e.g. "9.9.9.9@853#dns.quad9.net" (IPv4/IPv6, optional @port, optional #hostname)
    const m = /^([0-9a-fA-F:.]+)(?:@(\d+))?(?:#([A-Za-z0-9.-]+))?$/.exec(addr.trim())
    if (!m) continue
    const ip = m[1]
    const port = m[2] ?? '853'
    const host = m[3] ?? ip
    if (port !== '853') continue // only DoT upstreams have a TLS cert to check
    // ip is [0-9a-fA-F:.] and host is [A-Za-z0-9.-] by the regex above — no shell metachars.
    const cmd =
      `echo | timeout 8 openssl s_client -connect ${ip}:${port} -servername ${host} 2>/dev/null ` +
      `| openssl x509 -noout -enddate 2>/dev/null`
    const res = await ssh.execCommand(cmd)
    const em = /notAfter=(.+)/.exec(res.stdout)
    if (!em) continue
    const expiry = new Date(em[1].trim())
    if (isNaN(expiry.getTime())) continue
    out.push({ host, daysLeft: Math.floor((expiry.getTime() - Date.now()) / 86_400_000) })
  }
  return out
}

// ---- Orchestrator (called fire-and-forget from the poll worker) ------------

/**
 * Runs the SSH-based health sweep for one instance: disk/SD, DoT cert expiry,
 * and recursor latency. Self-gated to `health_check_interval_seconds`; emits
 * notifications (with a 1h per-type cooldown) via the notification centre.
 * Best-effort — never throws.
 */
export async function runHealthChecks(instance: InstanceRef): Promise<void> {
  if (!instance.sshUsername) return

  const intervalMs = await getHealthIntervalMs()
  const last = healthState.lastRun.get(instance.id) ?? 0
  if (Date.now() - last < intervalMs) return
  healthState.lastRun.set(instance.id, Date.now())

  let ssh: NodeSSH | null = null
  try {
    ssh = await connectSSH({
      host: extractHost(instance.url),
      username: instance.sshUsername,
      passwordEncrypted: instance.sshPasswordEncrypted,
    })

    // Disk / SD health
    try {
      const disk = await getDiskHealth(ssh)
      // No usable reading and not read-only: leave any live condition as is.
      if (disk.usedPct === null && !disk.readOnly) throw new Error('could not parse df output')
      const usedPct = disk.usedPct ?? 0
      let sev: Severity | null = null
      let msg = `Disk usage on ${instance.name} is ${usedPct}%.`
      if (disk.readOnly) {
        sev = 'critical'
        msg = `Root filesystem on ${instance.name} is mounted READ-ONLY — likely SD-card failure. Investigate immediately.`
      } else if (usedPct >= SD_CRIT_PCT) {
        sev = 'critical'
        msg = `Disk usage on ${instance.name} is ${usedPct}% (critical ≥ ${SD_CRIT_PCT}%).`
      } else if (usedPct >= SD_WARN_PCT) {
        sev = 'warning'
        msg = `Disk usage on ${instance.name} is ${usedPct}% (warning ≥ ${SD_WARN_PCT}%).`
      }
      const live = await getConditionSeverity('sd_health', instance.id)
      const effective = severityWithHysteresis(sev, live, disk.readOnly || usedPct >= SD_CLEAR_PCT)
      await notifyCondition({
        type: 'sd_health',
        severity: effective ?? 'warning',
        title: `Disk Health: ${instance.name}`,
        message: msg,
        instanceId: instance.id,
        active: effective !== null,
      })
    } catch (err) {
      console.error(`[health] disk check failed for ${instance.name}: ${errMsg(err)}`)
    }

    // DoT upstream certificate expiry
    try {
      const certs = await checkCertExpiry(ssh)
      const soonest = certs.sort((a, b) => a.daysLeft - b.daysLeft)[0]
      if (soonest) {
        let sev: Severity | null = null
        if (soonest.daysLeft < CERT_CRIT_DAYS) sev = 'critical'
        else if (soonest.daysLeft < CERT_WARN_DAYS) sev = 'warning'
        // daysLeft only decreases until renewal (which jumps it well clear of
        // the warn window), so this cannot flap — no hysteresis band needed.
        // As a live row the day count stays current instead of being frozen at
        // whatever it was when the alert first fired.
        await notifyCondition({
          type: 'cert_expiry',
          severity: sev ?? 'warning',
          title: `DoT Certificate Expiring: ${instance.name}`,
          message: `Upstream ${soonest.host} TLS certificate expires in ${soonest.daysLeft} day(s).`,
          instanceId: instance.id,
          active: sev !== null,
        })
      }
    } catch (err) {
      console.error(`[health] cert check failed for ${instance.name}: ${errMsg(err)}`)
    }

    // Recursor latency
    try {
      const dot = await testDotHealth(ssh)
      if (dot.ok && dot.latencyMs !== null) {
        let sev: Severity | null = null
        if (dot.latencyMs > LATENCY_CRIT_MS) sev = 'critical'
        else if (dot.latencyMs > LATENCY_WARN_MS) sev = 'warning'
        // Latency is the one genuinely noisy metric here — without the
        // hysteresis band, a value hovering near LATENCY_WARN_MS would resolve
        // and re-raise every sweep (up to 96 rows/day at a 15m interval), which
        // is worse than the hourly rate limiter this replaced.
        const live = await getConditionSeverity('latency_high', instance.id)
        const effective = severityWithHysteresis(sev, live, dot.latencyMs >= LATENCY_CLEAR_MS)
        await notifyCondition({
          type: 'latency_high',
          severity: effective ?? 'warning',
          title: `High DNS Latency: ${instance.name}`,
          message: `Recursor query time on ${instance.name} is ${dot.latencyMs}ms (warn > ${LATENCY_WARN_MS}ms).`,
          instanceId: instance.id,
          active: effective !== null,
        })
      }
    } catch (err) {
      console.error(`[health] latency check failed for ${instance.name}: ${errMsg(err)}`)
    }
  } catch (err) {
    console.error(`[health] SSH connect failed for ${instance.name}: ${errMsg(err)}`)
  } finally {
    if (ssh) ssh.dispose()
  }
}

// ---- Host (Pi-hole Central itself) ------------------------------------------

// The LXC root disk is small (9.8G) and every deploy builds a ~1.5GB image,
// so low free space is what actually bites here, not the percentage alone.
const HOST_WARN_FREE_BYTES = 2 * 1024 ** 3
const HOST_CRIT_FREE_BYTES = 1 * 1024 ** 3
const HOST_CLEAR_FREE_BYTES = 2.5 * 1024 ** 3
const HOST_KEY = '__host__'

/**
 * Free space on the filesystem holding the database (inside the container
 * that is the bind-mounted ./data, i.e. the LXC root disk). Raised as an
 * sd_health condition with no instance, so it shows in the bell and pushes
 * through the same Disk Health alert settings.
 */
export async function runHostDiskCheck(): Promise<void> {
  const intervalMs = await getHealthIntervalMs()
  const last = healthState.lastRun.get(HOST_KEY) ?? 0
  if (Date.now() - last < intervalMs) return
  healthState.lastRun.set(HOST_KEY, Date.now())

  try {
    const { statfsSync } = await import('node:fs')
    const path = await import('node:path')
    const dbPath = process.env.DATABASE_URL?.replace('file:', '') ?? './data/pihole-central.db'
    // turbopackIgnore: without it the build's file tracing cannot scope this
    // env-derived path and copies the WHOLE project into the server output.
    const st = statfsSync(path.dirname(path.resolve(/*turbopackIgnore: true*/ dbPath)))
    const total = Number(st.blocks) * Number(st.bsize)
    const free = Number(st.bavail) * Number(st.bsize)
    if (!(total > 0)) throw new Error('statfs returned no size')
    const usedPct = Math.round(((total - free) / total) * 100)
    const freeGiB = (free / 1024 ** 3).toFixed(1)

    let sev: Severity | null = null
    if (usedPct >= SD_CRIT_PCT || free < HOST_CRIT_FREE_BYTES) sev = 'critical'
    else if (usedPct >= SD_WARN_PCT || free < HOST_WARN_FREE_BYTES) sev = 'warning'
    const live = await getConditionSeverity('sd_health', null)
    const inBand = usedPct >= SD_CLEAR_PCT || free < HOST_CLEAR_FREE_BYTES
    const effective = severityWithHysteresis(sev, live, inBand)
    await notifyCondition({
      type: 'sd_health',
      severity: effective ?? 'warning',
      title: 'Disk Health: Pi-hole Central host',
      message: `The Pi-hole Central host disk is ${usedPct}% used with ${freeGiB} GiB free. Deploys need about 1.5 GiB to rebuild the image.`,
      instanceId: null,
      active: effective !== null,
    })
  } catch (err) {
    console.error(`[health] host disk check failed: ${errMsg(err)}`)
  }
}
