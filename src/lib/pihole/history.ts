import { globalSingleton } from '@/lib/global-state'
import * as piholeClient from './client'
import { coalesced, raceSignal, NodeBusyError } from './node-load'

/**
 * Per-node query history for the instance page and the dashboard (P5.1, R2-NV2).
 *
 * 7/30-day history comes from FTL's on-disk database and is slow on the real
 * nodes (30 days: ~60 s on .16, ~17 s on .8), so it is cached here:
 *
 * - One node call per (instance, URL, range) at a time, shared by every
 *   request that asks meanwhile, in the node's heavy lane (one heavy call per
 *   node), with a 120 s timeout that starts once the lane is free.
 * - The call is "detached": not tied to any request. A request that gives up
 *   (or a browser that navigates away) stops waiting, but the call finishes and
 *   fills the cache, so the next visit gets the answer at once. Before this the
 *   30-day view never loaded: the 10 s apiFetch timeout always fired first.
 * - Fresh for 1 h (30 d) / 15 min (7 d). An older entry (up to 24 h) is still
 *   served at once while one background refresh runs, so only the very first
 *   visit after a restart waits for the node.
 * - A failure is remembered for 60 s, so a node that cannot answer is not
 *   handed a new 120 s scan on every click.
 *
 * Why not stats_snapshots: those rows hold the summary's rolling 24 h
 * `queries.total`/`blocked` counters sampled each poll (zeros while offline,
 * pruned by retention_days), not per-interval counts, so the 1 h / 6 h buckets
 * the chart shows cannot be derived from them without changing the numbers.
 *
 * 24 h history (/api/history) is FTL's in-memory data and fast; it is only
 * coalesced and cached for 30 s, and stays outside the heavy lane.
 */

export type HistoryRow = { timestamp: number; total: number; blocked: number }

const RANGE_TIMEOUT_MS = 120_000
const FAILURE_TTL_MS = 60_000
const STALE_MAX_MS = 24 * 3600_000
const LIVE_TTL_MS = 30_000

// A failed refresh keeps the last good data (served while < 24 h old) and
// only records when it failed, so no refresh is retried for 60 s.
type Entry = { data?: HistoryRow[]; at: number; error?: unknown; failedAt?: number }
const cache = globalSingleton('__piholeHistoryCache', () => new Map<string, Entry>())

function bucketData(rows: HistoryRow[], bucketSeconds: number): HistoryRow[] {
  const buckets = new Map<number, { blocked: number; total: number }>()
  for (const row of rows) {
    const bucket = Math.floor(row.timestamp / bucketSeconds) * bucketSeconds
    const existing = buckets.get(bucket) ?? { blocked: 0, total: 0 }
    buckets.set(bucket, {
      blocked: existing.blocked + row.blocked,
      total: existing.total + row.total,
    })
  }
  return Array.from(buckets.entries())
    .map(([timestamp, v]) => ({ timestamp, ...v }))
    .sort((a, b) => a.timestamp - b.timestamp)
}

/** Fetch (shared, detached) and store the result or the failure under `key`. */
function fill(key: string, lane: string | undefined, load: (signal: AbortSignal) => Promise<HistoryRow[]>): Promise<HistoryRow[]> {
  return coalesced(
    key,
    async (signal) => {
      try {
        const data = await load(signal)
        cache.set(key, { data, at: Date.now() })
        return data
      } catch (error) {
        // A full lane queue says nothing about the node; don't block retries.
        if (error instanceof NodeBusyError) throw error
        const prev = cache.get(key)
        cache.set(key, { data: prev?.data, at: prev?.at ?? 0, error, failedAt: Date.now() })
        throw error
      }
    },
    { lane, detached: true }
  )
}

/**
 * Live 24 h history (10-min buckets) for one instance. Coalesced, 30 s cache,
 * not in the heavy lane. Also used by /api/stats/blocks.
 */
export async function getLiveHistory(instanceId: string, signal?: AbortSignal): Promise<HistoryRow[]> {
  const key = `live\n${instanceId}`
  const hit = cache.get(key)
  if (hit?.data && Date.now() - hit.at < LIVE_TTL_MS) return hit.data
  return raceSignal(
    fill(key, undefined, () => piholeClient.getQueryHistory(instanceId)),
    signal
  )
}

/**
 * History for the instance page: 24 h raw, 7 d in 1 h buckets, 30 d in 6 h
 * buckets. `signal` only stops this caller waiting (see the module comment).
 */
export async function getInstanceHistory(
  instance: { id: string; url: string },
  hours: 24 | 168 | 720,
  signal?: AbortSignal
): Promise<HistoryRow[]> {
  if (hours === 24) return getLiveHistory(instance.id, signal)

  const url = instance.url.replace(/\/$/, '')
  const key = `range\n${instance.id}\n${url}\n${hours}`
  const ttl = hours === 720 ? 3600_000 : 15 * 60_000
  const bucketSeconds = hours === 720 ? 21600 : 3600
  const load = async (shared: AbortSignal) => {
    const to = Math.floor(Date.now() / 1000)
    const raw = await piholeClient.getQueryHistoryRange(instance.id, to - hours * 3600, to, {
      signal: shared,
      timeoutMs: RANGE_TIMEOUT_MS,
    })
    return bucketData(raw, bucketSeconds)
  }

  const hit = cache.get(key)
  const now = Date.now()
  const failedRecently = hit?.failedAt !== undefined && now - hit.failedAt < FAILURE_TTL_MS
  if (hit?.data) {
    const age = now - hit.at
    if (age < ttl) return hit.data
    if (age < STALE_MAX_MS) {
      // Serve the older copy now; refresh in the background (one call, shared).
      if (!failedRecently) fill(key, url, load).catch(() => {})
      return hit.data
    }
  }
  if (failedRecently) throw hit!.error
  return raceSignal(fill(key, url, load), signal)
}
