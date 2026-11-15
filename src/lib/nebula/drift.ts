import { db } from '@/lib/db'
import { instances } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import * as piholeClient from '@/lib/pihole/client'
import { globalSingleton } from '@/lib/global-state'
import { coalescedCache } from '@/lib/nebula/coalesced-cache'
import { notifyCondition } from '@/lib/notifications/center'

// nebula-sync replicates config (gravity, adlists, groups, domains, clients)
// from the primary node to the replica(s). We can't query nebula-sync itself
// (no API, host not reachable), but we CAN compare the resulting config counts
// across the nodes pihole-central already talks to — an independent "are they
// actually in sync?" signal.

const METRICS: { key: MetricKey; label: string }[] = [
  { key: 'gravity', label: 'Gravity domains' },
  { key: 'adlists', label: 'Adlists' },
  { key: 'groups', label: 'Groups' },
  { key: 'allow', label: 'Allowed domains' },
  { key: 'deny', label: 'Denied domains' },
  { key: 'clients', label: 'Clients' },
]

type MetricKey = 'gravity' | 'adlists' | 'groups' | 'allow' | 'deny' | 'clients'
type Metrics = Record<MetricKey, number>

export type InstanceMetrics = {
  id: string
  name: string
  online: boolean
  metrics: Metrics | null
  error?: string
}

export type MetricComparison = {
  key: MetricKey
  label: string
  values: Record<string, number>
  inSync: boolean
}

export type SyncStatus = {
  checkedAt: string
  comparable: boolean // at least 2 nodes online to compare
  inSync: boolean
  instances: InstanceMetrics[]
  metrics: MetricComparison[]
}

/**
 * Every metric must match EXACTLY across nodes — including gravity.
 *
 * A tolerance was briefly used here on the theory that gravity counts drift
 * harmlessly because each node rebuilds on its own schedule. Measurement
 * disproved it: the observed 43-domain gap was stable across nebula-sync cycles
 * and across a day, because nebula-sync replicates the adlist *config* but does
 * not rebuild the gravity table. A persistent gap means the nodes genuinely
 * block different sets of domains — one node allows what the other blocks,
 * which is exactly the failure this check exists to catch. A tolerance would
 * hide it.
 *
 * Repeat-alert fatigue is handled by making this a sticky condition (one live
 * notification, updated in place) rather than by loosening the comparison.
 */
/**
 * Above this many gravity domains apart, the gap is more likely stale cached
 * lists from failed downloads than ordinary rebuild-timing skew. Only affects
 * the wording of the advice — the drift check itself stays exact-match.
 */
const GRAVITY_STALE_HINT = 1000

export function valuesInSync(_key: MetricKey, values: number[]): boolean {
  if (values.length <= 1) return true
  return new Set(values).size === 1
}

// Six Pi-hole GETs per enabled node per computation: one at a time (coalesced),
// cached for 60 s, and a forced refresh at most every 10 s (audit R2-NV1).
const CACHE_TTL_MS = 60_000
const MIN_REFRESH_MS = 10_000
const cache = coalescedCache<SyncStatus>('__piholeCentralNebulaCacheV2', {
  ttlMs: CACHE_TTL_MS,
  minRefreshMs: MIN_REFRESH_MS,
})

async function collectMetrics(id: string): Promise<Metrics> {
  const [summary, lists, groups, allow, deny, clients] = await Promise.all([
    piholeClient.getSummary(id),
    piholeClient.getLists(id),
    piholeClient.getGroups(id),
    piholeClient.getDomains(id, 'allow'),
    piholeClient.getDomains(id, 'deny'),
    piholeClient.getClients(id),
  ])
  return {
    gravity: summary.gravity?.domains_being_blocked ?? 0,
    adlists: lists.length,
    groups: groups.length,
    allow: allow.length,
    deny: deny.length,
    clients: clients.length,
  }
}

async function computeStatus(): Promise<SyncStatus> {
  const enabled = await db.query.instances.findMany({ where: eq(instances.enabled, true) })
  const perInstance: InstanceMetrics[] = await Promise.all(
    enabled.map(async (i): Promise<InstanceMetrics> => {
      try {
        return { id: i.id, name: i.name, online: true, metrics: await collectMetrics(i.id) }
      } catch (err) {
        return { id: i.id, name: i.name, online: false, metrics: null, error: err instanceof Error ? err.message : 'unreachable' }
      }
    })
  )

  const online = perInstance.filter((p) => p.online && p.metrics)
  const metrics: MetricComparison[] = METRICS.map(({ key, label }) => {
    const values: Record<string, number> = {}
    for (const p of online) values[p.id] = p.metrics![key]
    return { key, label, values, inSync: valuesInSync(key, Object.values(values)) }
  })
  const comparable = online.length >= 2
  const inSync = comparable && metrics.every((m) => m.inSync)

  return { checkedAt: new Date().toISOString(), comparable, inSync, instances: perInstance, metrics }
}

/**
 * Cached sync status: recomputed at most once per CACHE_TTL_MS, or per
 * MIN_REFRESH_MS when forced; concurrent callers share one computation.
 */
export async function getSyncStatus(force = false): Promise<SyncStatus> {
  return cache.get('', force, computeStatus)
}

// Periodic drift check → sticky condition. Self-gated to roughly the nebula-sync
// cadence. Drift is a STATE, not an event: while the nodes disagree there is one
// live notification whose detail is refreshed in place, and it resolves when
// they match again. The original 1h cooldown was a rate limiter, which re-alerted
// hourly forever (158 rows in 7 days from one unchanging condition).
const driftState = globalSingleton('__piholeCentralNebulaDrift', () => ({
  lastCheckAt: 0,
}))
const CHECK_INTERVAL_MS = 15 * 60 * 1000

export async function runNebulaDriftCheck(): Promise<void> {
  if (Date.now() - driftState.lastCheckAt < CHECK_INTERVAL_MS) return
  driftState.lastCheckAt = Date.now()

  let status: SyncStatus
  try {
    status = await getSyncStatus(true)
  } catch (err) {
    console.error('[nebula] drift check failed:', err)
    return
  }
  // Fewer than 2 nodes online is "can't tell", not "in sync" — leave the live
  // condition untouched so a node outage doesn't fake a resolution.
  if (!status.comparable) return

  const drifted = status.metrics.filter((m) => !m.inSync)

  // Spell out the actual gap per metric. Because the row is refreshed in place,
  // this message is a live readout of the current divergence rather than a
  // snapshot frozen at whenever the alert first fired.
  const detail = drifted
    .map((m) => {
      const values = Object.values(m.values)
      const spread = Math.max(...values) - Math.min(...values)
      return `${m.label} differ by ${spread.toLocaleString()}`
    })
    .join('; ')

  // Gravity gets different advice from the config metrics, because the cause is
  // different. nebula-sync replicates adlist CONFIG, not the gravity table, so
  // each node builds gravity from its own downloads.
  //
  // A SMALL gap is normal: the nodes rebuild at different times and upstream
  // lists change continuously, so a handful of domains apart is just clock skew.
  // A LARGE gap means blocklist downloads failed on one node (503s from
  // raw.githubusercontent.com are routine) and it fell back to its own stale
  // cached copy — measured 2026-08-14, a failure episode left the nodes 10,746
  // apart, and a clean `pihole -g` on both brought them to within 1.
  const gravity = drifted.find((m) => m.key === 'gravity')
  const gravitySpread = gravity
    ? Math.max(...Object.values(gravity.values)) - Math.min(...Object.values(gravity.values))
    : 0
  const configDrifted = drifted.filter((m) => m.key !== 'gravity')

  const advice = configDrifted.length
    ? 'nebula-sync replicates adlist config across nodes, so a config metric differing points at a sync failure — check the nebula-sync container.'
    : gravitySpread > GRAVITY_STALE_HINT
      ? 'A gap this large usually means blocklist downloads failed on one node and it fell back to stale cached lists. Run `pihole -g` on one node, wait for it to finish, then the other (never both at once: GitHub rate-limits the shared IP), and check for "List download failed" in the output.'
      : 'Gravity is rebuilt independently per node, so a small gap is expected when the two rebuild at different times.'

  // Naming the drifted metrics in the TITLE is load-bearing, not cosmetic:
  // notifyCondition() resurfaces a live row when its title changes, so a newly
  // drifting metric re-alerts even though the condition was already active.
  // Gravity is expected to sit permanently slightly out of sync (each node
  // builds its own lists by design), so without this a real config drift would
  // hide behind it — the message would change on an already-read row and never
  // draw attention.
  //
  // Config drift is also the more serious case: nebula-sync is supposed to
  // replicate that, so it failing means the sync itself is broken.
  const title = configDrifted.length
    ? `Nebula-sync: config out of sync (${configDrifted.map((m) => m.label).join(', ')})`
    : 'Nebula-sync: gravity counts differ'

  await notifyCondition({
    type: 'nebula_sync_drift',
    severity: configDrifted.length ? 'critical' : 'warning',
    title,
    message: `${detail}. ${advice}`,
    active: drifted.length > 0,
  })
}
