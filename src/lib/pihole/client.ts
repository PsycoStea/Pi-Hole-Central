import type {
  PiHoleSummary,
  TopDomain,
  TopClient,
  PiHoleSession,
  BlockingStatus,
  PiHoleQuery,
  Domain,
  Group,
  Client,
  AdList,
} from './types'
import { db } from '@/lib/db'
import { instances } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { decrypt } from '@/lib/crypto'
import { globalSingleton } from '@/lib/global-state'
import { nodeFetch, FormData, type NodeResponse, type NodeFetchInit } from './transport'
import { coalesced } from './node-load'

// In-memory session cache. Anchored on globalThis (see global-state.ts): as a
// plain module-level Map, every server chunk that bundles this module kept its
// own SID per node, so the app held several Pi-hole sessions at once and the
// shutdown logout only released one chunk's.
const sessions = globalSingleton('__piholeSessions', () => new Map<string, PiHoleSession>())
// Deduplicates concurrent auth requests for the same instance
// Keyed by instance id AND url (R3A-D1): an auth started against a node's old
// URL must not be handed to a request for its new one.
const pendingAuth = globalSingleton(
  '__piholePendingAuth',
  () => new Map<string, Promise<PiHoleSession>>()
)
const pendingKey = (instanceId: string, url: string) => `${instanceId}\n${url}`

// "<url>\n<sid>" of SIDs already being logged out after a 401 (see invalidateSid).
const loggedOutSids = globalSingleton('__piholeLoggedOutSids', () => new Set<string>())

/**
 * Drop a SID that just got a 401 — but only if it is still the cached one.
 * Evicting "whatever is cached" let two requests that failed on the same old
 * SID race: the first re-authenticated, then the second evicted and logged out
 * the brand-new session, failing every request that was using it.
 */
function invalidateSid(instanceId: string, url: string, sid: string): void {
  if (sessions.get(instanceId)?.sid === sid) sessions.delete(instanceId)
  // Several requests that were sent with the same SID all get a 401; only the
  // first may send DELETE /api/auth for it (P5.8). The key is kept for a while
  // because the 401s can come back seconds apart; a dead SID is never reissued.
  const key = `${url}\n${sid}`
  if (loggedOutSids.has(key)) return
  loggedOutSids.add(key)
  setTimeout(() => loggedOutSids.delete(key), 10 * 60_000).unref?.()
  void logout(url, sid)
}

/**
 * Forget an instance's session (and release it on the node). For URL/password
 * changes and deletes. The logout goes to the URL the SID was issued by, never
 * to a URL the caller names (R3A-D1); `_url` is kept for existing callers.
 */
export async function evictSession(instanceId: string, _url?: string): Promise<void> {
  const cached = sessions.get(instanceId)
  sessions.delete(instanceId)
  if (cached) await logout(cached.url, cached.sid)
}

type Processed = { processed?: { errors?: Array<{ item?: string; error?: string }> } | null }

/**
 * v6 list-type writes (domains, groups, lists, clients) answer 2xx even when an
 * item was rejected, and report it in `processed.errors` — e.g. "The item is
 * already present". Treat any such error as a failure instead of success.
 */
function assertProcessed(data: unknown, what: string): void {
  const errors = (data as Processed | null)?.processed?.errors ?? []
  if (errors.length) {
    throw new Error(`Pi-hole rejected ${what}: ${errors.map((e) => `${e.item ?? '?'}: ${e.error ?? 'error'}`).join('; ')}`)
  }
}

/** True if an error from apiFetch was an HTTP 404 from the node. */
export function isNotFound(err: unknown): boolean {
  return err instanceof Error && /^Pi-Hole API error 404 /.test(err.message)
}

async function getInstanceConfig(instanceId: string) {
  const instance = await db.query.instances.findFirst({
    where: eq(instances.id, instanceId),
  })
  if (!instance) throw new Error(`Instance ${instanceId} not found`)
  return {
    id: instance.id,
    url: instance.url.replace(/\/$/, ''),
    password: decrypt(instance.passwordEncrypted),
  }
}

/**
 * Release a Pi-hole session so it does not linger on the node until its
 * validity lapses. Pi-hole v6 caps concurrent API sessions, so orphaned SIDs
 * (from re-auth, container restarts, or one-shot calls like testConnection)
 * accumulate into 429 "session exhausted" errors. Best-effort: never throws.
 */
async function logout(url: string, sid: string): Promise<void> {
  try {
    const res = await nodeFetch(`${url}/api/auth`, {
      method: 'DELETE',
      headers: { 'X-FTL-SID': sid },
      signal: AbortSignal.timeout(5_000),
    })
    await res.body?.cancel().catch(() => {})
  } catch {
    // Node may be down / already expired the session — nothing to clean up.
  }
}

/** Log out every cached session (used on process shutdown). */
export async function logoutAllSessions(): Promise<void> {
  const entries = [...sessions.entries()]
  sessions.clear()
  await Promise.allSettled(
    // Each SID goes back to the URL that issued it, whatever the DB now says.
    entries.map(([, session]) => logout(session.url, session.sid))
  )
}

// Size caps on what a node may send back (R3B-F4). Bodies used to be buffered
// whole, so a broken or hostile node could make the app hold (and, for a
// Teleporter export, write to disk) any amount of data. Measured 2026-11-13 on
// .16: the largest normal replies are ~300 KiB (/queries length=1000, 30-day
// history 334 KiB) and an export is ~34 KiB, so these leave wide headroom.
const MAX_API_BODY = 5 * 1024 * 1024
const MAX_TELEPORTER_BODY = 20 * 1024 * 1024
const MAX_ERROR_BODY = 64 * 1024

/** Read a response body, refusing (and cancelling) past `max` bytes. */
async function readCapped(res: NodeResponse, max: number, what: string): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => {})
    throw new Error(`${what}: node reply of ${declared} bytes is over the ${max}-byte limit`)
  }
  if (!res.body) return Buffer.alloc(0)
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => {})
      throw new Error(`${what}: node reply is over the ${max}-byte limit`)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

const readText = async (res: NodeResponse, max: number, what: string) => (await readCapped(res, max, what)).toString('utf8')
const readJson = async <T>(res: NodeResponse, max: number, what: string): Promise<T> => {
  const text = await readText(res, max, what)
  return (text ? JSON.parse(text) : {}) as T
}
/** Error bodies are only for messages: small cap, never throws. */
const readErrorText = (res: NodeResponse) => readText(res, MAX_ERROR_BODY, 'error body').catch(() => '')

async function authenticate(url: string, password: string): Promise<PiHoleSession> {
  const res = await nodeFetch(`${url}/api/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) {
    await res.body?.cancel().catch(() => {})
    throw new Error(`Auth failed: ${res.status}`)
  }
  const data = await readJson<{ session?: { sid?: string; validity?: number }; sid?: string }>(res, MAX_ERROR_BODY, 'auth')
  const sid = data.session?.sid ?? data.sid
  // A node with no password set answers valid:true with sid null; sending the
  // string "null" as X-FTL-SID would then fail every request confusingly.
  if (!sid) throw new Error('Auth returned no session id (is a password / app password set on the node?)')
  // Use Pi-Hole's reported validity minus a 50s safety margin; fall back to 1750s
  const validity: number = data.session?.validity ?? 1800
  const expiresAt = Date.now() + (validity - 50) * 1000
  return { url, sid, expiresAt }
}

// After a 429 from /api/auth (all API session seats taken), stop re-authenticating
// for a minute. Without this every request and every poll tick tried again,
// which kept the seats exhausted.
const AUTH_BACKOFF_MS = 60_000
const authBackoffUntil = globalSingleton('__piholeAuthBackoff', () => new Map<string, number>())

async function getSid(instanceId: string): Promise<{ url: string; sid: string }> {
  const config = await getInstanceConfig(instanceId)
  const cached = sessions.get(instanceId)
  // A SID is only ever sent to the URL that issued it (R3A-D1).
  if (cached && cached.url === config.url && cached.expiresAt > Date.now() + 30_000) {
    return { url: cached.url, sid: cached.sid }
  }

  // Cached session is stale/expired or from the node's old URL — release it
  // where it came from before re-auth so we don't orphan a session slot
  // (fire-and-forget).
  if (cached) {
    sessions.delete(instanceId)
    void logout(cached.url, cached.sid)
  }

  // Deduplicate: if an auth request is already in-flight for this instance and URL, wait for it
  const key = pendingKey(instanceId, config.url)
  let pending = pendingAuth.get(key)
  if (!pending) {
    const backoff = authBackoffUntil.get(instanceId) ?? 0
    if (Date.now() < backoff) {
      throw new Error(`Auth backing off for ${Math.ceil((backoff - Date.now()) / 1000)}s after the node reported no free API sessions (429)`)
    }
    pending = authenticate(config.url, config.password).then(
      (result) => {
        // An auth for a node's old URL can finish after one for its new URL
        // has been cached (or the reverse). Whichever session is displaced
        // gets logged out where it came from, so no API seat is orphaned
        // (orphaned SIDs were the 2026-06 HTTP 429 incident).
        const displaced = sessions.get(instanceId)
        sessions.set(instanceId, result)
        if (displaced && displaced.sid !== result.sid) void logout(displaced.url, displaced.sid)
        pendingAuth.delete(key)
        return result
      },
      (err) => {
        pendingAuth.delete(key)
        if (err instanceof Error && err.message === 'Auth failed: 429') {
          authBackoffUntil.set(instanceId, Date.now() + AUTH_BACKOFF_MS)
        }
        throw err
      }
    )
    pendingAuth.set(key, pending)
  }

  const session = await pending
  return { url: session.url, sid: session.sid }
}

/**
 * Encode one path segment for the Pi-hole API. encodeURIComponent leaves "."
 * and ".." alone and fetch() then normalises them away, so DELETE
 * /domains/allow/exact/.. became DELETE /domains/allow (R2-F6): a different
 * resource than the one named. Refuse those (and empty) outright.
 */
function pathItem(v: string, what: string): string {
  if (v === '' || v === '.' || v === '..') {
    throw new Error(`Refusing ${what} "${v}": it would change which API path is called`)
  }
  return encodeURIComponent(v)
}

type ApiInit = NodeFetchInit & {
  /** Per-call timeout (default 10 s). Combined with `signal` when one is given. */
  timeoutMs?: number
}

/**
 * `options.signal` is the caller's signal (the request's, or a shared call's):
 * aborting it cancels the node call, so work stops when nobody wants the
 * answer (R2-NV2). It is never passed to getSid: the auth is shared.
 */
async function apiFetch<T>(
  instanceId: string,
  path: string,
  options?: ApiInit,
  retry = true
): Promise<T> {
  const { timeoutMs = 10_000, signal: caller, ...init } = options ?? {}
  caller?.throwIfAborted()
  const { url, sid } = await getSid(instanceId)
  caller?.throwIfAborted()
  const timeout = AbortSignal.timeout(timeoutMs)
  const res = await nodeFetch(`${url}/api${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'X-FTL-SID': sid,
      ...init.headers,
    },
    signal: caller ? AbortSignal.any([caller, timeout]) : timeout,
  })
  if (res.status === 401 && retry) {
    await res.body?.cancel().catch(() => {})
    invalidateSid(instanceId, url, sid)
    return apiFetch(instanceId, path, options, false)
  }
  if (!res.ok) {
    const body = (await readErrorText(res)).slice(0, 500)
    throw new Error(`Pi-Hole API error ${res.status} on ${path}: ${body}`)
  }
  return readJson<T>(res, MAX_API_BODY, path)
}

export async function testConnection(url: string, password: string): Promise<PiHoleSummary> {
  const cleanUrl = url.replace(/\/$/, '')
  const { sid } = await authenticate(cleanUrl, password)
  try {
    const res = await nodeFetch(`${cleanUrl}/api/stats/summary`, {
      headers: { 'X-FTL-SID': sid },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`Connection test failed: ${res.status}`)
    return await readJson<PiHoleSummary>(res, MAX_API_BODY, 'test-connection')
  } finally {
    // This SID is never cached, so release it immediately or it orphans a
    // session slot on the node on every test-connection call.
    void logout(cleanUrl, sid)
  }
}

export async function getSummary(instanceId: string): Promise<PiHoleSummary> {
  return apiFetch<PiHoleSummary>(instanceId, '/stats/summary')
}

export async function getTopDomains(instanceId: string, count = 10, signal?: AbortSignal): Promise<TopDomain[]> {
  const data = await apiFetch<{ domains: Array<{ domain: string; count: number }> }>(
    instanceId,
    `/stats/top_domains?count=${count}`,
    { signal }
  )
  return data.domains ?? []
}

export async function getTopClients(instanceId: string, count = 10, signal?: AbortSignal): Promise<TopClient[]> {
  const data = await apiFetch<{
    clients: Array<{ ip: string; name: string; count: number }>
  }>(instanceId, `/stats/top_clients?count=${count}`, { signal })
  return data.clients ?? []
}

export async function getBlockingStatus(instanceId: string): Promise<BlockingStatus> {
  return apiFetch<BlockingStatus>(instanceId, '/dns/blocking')
}

export async function setBlocking(
  instanceId: string,
  enabled: boolean,
  timer?: number
): Promise<BlockingStatus> {
  return apiFetch<BlockingStatus>(instanceId, '/dns/blocking', {
    method: 'POST',
    body: JSON.stringify({ blocking: enabled, timer: timer ?? null }),
  })
}

export async function addDomain(
  instanceId: string,
  domain: string,
  list: 'allow' | 'deny',
  kind: 'exact' | 'regex' = 'exact',
  comment = '',
  groups = [0],
  enabled = true
): Promise<void> {
  assertListKind(list, kind)
  const data = await apiFetch(instanceId, `/domains/${list}/${kind}`, {
    method: 'POST',
    body: JSON.stringify({ domain, comment, groups, enabled }),
  })
  assertProcessed(data, `domain ${domain}`)
}

// list and kind are interpolated into the URL path, so only the four real
// values may pass — anything else (e.g. "../../action/flush/logs") would reach
// other Pi-hole endpoints with the app's session.
function assertListKind(list: string, kind: string): void {
  if (list !== 'allow' && list !== 'deny') throw new Error(`Invalid list "${list}"`)
  if (kind !== 'exact' && kind !== 'regex') throw new Error(`Invalid kind "${kind}"`)
}

export async function removeDomain(
  instanceId: string,
  list: 'allow' | 'deny',
  kind: string,
  domain: string
): Promise<void> {
  assertListKind(list, kind)
  await apiFetch(instanceId, `/domains/${list}/${kind}/${pathItem(domain, 'domain')}`, {
    method: 'DELETE',
  })
}

// One gravity run at a time across ALL nodes. Both nodes pull their
// blocklists from GitHub through the same public IP, and running them together
// trips GitHub's per-IP rate limit, leaving a node on stale cached lists.
// Every caller (bulk route, per-node route, the UI's "all instances" loop)
// goes through this queue, so concurrent requests are serialised server-side.
const gravityQueue = globalSingleton('__piholeGravityQueue', () => ({
  tail: Promise.resolve() as Promise<unknown>,
}))
// A Pi Zero 2W takes a few minutes for a full rebuild.
const GRAVITY_TIMEOUT_MS = 10 * 60_000

export type GravityResult = { failedLists: number }

export function triggerGravity(instanceId: string): Promise<GravityResult> {
  const run = gravityQueue.tail.then(
    () => runGravity(instanceId),
    () => runGravity(instanceId)
  )
  gravityQueue.tail = run.catch(() => {})
  return run
}

async function runGravity(instanceId: string, retry = true): Promise<GravityResult> {
  const { url, sid } = await getSid(instanceId)
  const res = await nodeFetch(`${url}/api/action/gravity`, {
    method: 'POST',
    headers: { 'X-FTL-SID': sid },
    signal: AbortSignal.timeout(GRAVITY_TIMEOUT_MS),
  })
  if (res.status === 401 && retry) {
    invalidateSid(instanceId, url, sid)
    return runGravity(instanceId, false)
  }
  if (res.status === 409) throw new Error('A gravity run is already in progress on this node')
  if (!res.ok) throw new Error(`Gravity failed: HTTP ${res.status}`)
  // The output is streamed while `pihole -g` runs. fetch() resolves on the
  // headers, so reading the body to the end is what makes "done" mean done.
  const output = await readText(res, MAX_API_BODY, 'gravity output')
  if (!/Swapping databases/.test(output)) {
    throw new Error('Gravity did not complete (no "Swapping databases" step in the output)')
  }
  const failedLists = (output.match(/List download failed/g) ?? []).length
  return { failedLists }
}

// Live: returns last 24h in 10-min intervals (no time params needed)
export async function getQueryHistory(
  instanceId: string
): Promise<{ timestamp: number; total: number; blocked: number }[]> {
  const data = await apiFetch<{
    history: Array<{ timestamp: number; total: number; blocked: number }>
  }>(instanceId, '/history')
  return (data.history ?? []).map((h) => ({
    timestamp: h.timestamp,
    total: h.total,
    blocked: h.blocked,
  }))
}

// Long-term: database history with from/until Unix timestamps in seconds.
// Slow on the real nodes (30 days: ~60 s on .16), so callers give it a long
// timeout and run it in the node's heavy lane (see history.ts).
export async function getQueryHistoryRange(
  instanceId: string,
  from: number,
  to: number,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<{ timestamp: number; total: number; blocked: number }[]> {
  const data = await apiFetch<{
    history: Array<{ timestamp: number; total: number; blocked: number }>
  }>(instanceId, `/history/database?from=${from}&until=${to}`, opts)
  return (data.history ?? []).map((h) => ({
    timestamp: h.timestamp,
    total: h.total,
    blocked: h.blocked,
  }))
}

export async function getDomains(
  instanceId: string,
  list: 'allow' | 'deny'
): Promise<Domain[]> {
  const data = await apiFetch<{ domains: Domain[] }>(instanceId, `/domains/${list}`)
  return data.domains ?? []
}

/** True when no entry with this list/kind/domain is on the node any more. */
export async function isDomainGone(
  instanceId: string,
  list: 'allow' | 'deny',
  kind: string,
  domain: string
): Promise<boolean> {
  const entries = await getDomains(instanceId, list)
  return !entries.some((d) => d.domain === domain && d.kind === kind)
}

export async function getGroups(instanceId: string): Promise<Group[]> {
  const data = await apiFetch<{ groups: Group[] }>(instanceId, '/groups')
  return data.groups ?? []
}

// Replace a group (v6 PUT /groups/{name}); used to toggle `enabled` on a schedule.
export async function updateGroup(
  instanceId: string,
  name: string,
  changes: { enabled?: boolean; comment?: string | null }
): Promise<void> {
  // v6 PUT replaces the whole object, so fetch current values first.
  const groups = await getGroups(instanceId)
  const current = groups.find((g) => g.name === name)
  if (!current) throw new Error(`Group "${name}" not found`)
  const data = await apiFetch(instanceId, `/groups/${pathItem(name, 'group')}`, {
    method: 'PUT',
    body: JSON.stringify({
      name,
      // v6 groups carry `comment` (this used to send `current.description`,
      // which doesn't exist, so every scheduled toggle wiped the comment).
      comment: changes.comment !== undefined ? changes.comment : current.comment,
      enabled: changes.enabled !== undefined ? changes.enabled : current.enabled,
    }),
  })
  assertProcessed(data, `group ${name}`)
}

export async function getClients(instanceId: string): Promise<Client[]> {
  const data = await apiFetch<{ clients: Client[] }>(instanceId, '/clients')
  return data.clients ?? []
}

export async function addClient(
  instanceId: string,
  client: string,
  comment = '',
  groups: number[] = [0]
): Promise<void> {
  const data = await apiFetch(instanceId, '/clients', {
    method: 'POST',
    body: JSON.stringify({ client, comment, groups }),
  })
  assertProcessed(data, `client ${client}`)
}

export async function updateClient(
  instanceId: string,
  client: string,
  changes: { comment?: string; groups?: number[] }
): Promise<void> {
  const clients = await getClients(instanceId)
  const current = clients.find((c) => c.client === client)
  if (!current) throw new Error(`Client "${client}" not found`)
  const data = await apiFetch(instanceId, `/clients/${pathItem(client, 'client')}`, {
    method: 'PUT',
    body: JSON.stringify({
      comment: changes.comment !== undefined ? changes.comment : (current.comment ?? ''),
      groups: changes.groups !== undefined ? changes.groups : current.groups,
    }),
  })
  assertProcessed(data, `client ${client}`)
}

export async function removeClient(instanceId: string, client: string): Promise<void> {
  await apiFetch(instanceId, `/clients/${pathItem(client, 'client')}`, { method: 'DELETE' })
}

// Teleporter export returns a binary zip, so it bypasses apiFetch's JSON path.
export async function teleporterExport(instanceId: string): Promise<Buffer> {
  const { url, sid } = await getSid(instanceId)
  const res = await nodeFetch(`${url}/api/teleporter`, {
    headers: { 'X-FTL-SID': sid },
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok) {
    const body = await readErrorText(res)
    throw new Error(`Teleporter export failed ${res.status}: ${body.slice(0, 200)}`)
  }
  return readCapped(res, MAX_TELEPORTER_BODY, 'Teleporter export')
}

// Teleporter import (restore) takes a multipart upload of a previously exported zip.
// Omitting the `import` field imports everything.
export async function teleporterImport(
  instanceId: string,
  file: Buffer,
  filename: string
): Promise<void> {
  const { url, sid } = await getSid(instanceId)
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(file)], { type: 'application/zip' }), filename)
  const res = await nodeFetch(`${url}/api/teleporter`, {
    method: 'POST',
    headers: { 'X-FTL-SID': sid },
    body: form,
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok) {
    const body = await readErrorText(res)
    throw new Error(`Teleporter import failed ${res.status}: ${body.slice(0, 200)}`)
  }
}

export async function getLists(instanceId: string): Promise<AdList[]> {
  const data = await apiFetch<{ lists: AdList[] }>(instanceId, '/lists?type=block')
  return data.lists ?? []
}

export async function addList(
  instanceId: string,
  address: string,
  comment = '',
  enabled = true,
  groups = [0]
): Promise<void> {
  const data = await apiFetch(instanceId, '/lists?type=block', {
    method: 'POST',
    body: JSON.stringify({ address, comment, enabled, groups }),
  })
  assertProcessed(data, `list ${address}`)
}

export async function removeList(instanceId: string, address: string): Promise<void> {
  await apiFetch(instanceId, `/lists/${pathItem(address, 'list address')}?type=block`, { method: 'DELETE' })
}

// v6 addresses a list by its URL-encoded ADDRESS, not its numeric id (the
// DELETE above already did this). PUTting `/lists/5` made the adlist enable
// toggle and group editor fail, or upsert a junk list whose address is "5".
export async function updateList(
  instanceId: string,
  address: string,
  comment: string,
  enabled: boolean,
  groups: number[]
): Promise<void> {
  const data = await apiFetch(instanceId, `/lists/${pathItem(address, 'list address')}?type=block`, {
    method: 'PUT',
    body: JSON.stringify({ comment, type: 'block', enabled, groups }),
  })
  assertProcessed(data, `list ${address}`)
}

/**
 * The node a heavy call lands on, for the per-node heavy lane (node-load.ts).
 * Keyed by URL, so two instance rows for the same node share one lane.
 */
export async function nodeLaneKey(instanceId: string): Promise<string> {
  const row = await db.query.instances.findFirst({
    where: eq(instances.id, instanceId),
    columns: { url: true },
  })
  if (!row) throw new Error(`Instance ${instanceId} not found`)
  return row.url.replace(/\/$/, '')
}

// Query-log time filters may only reach back this far (R2-NV2): the UI never
// asks for more, and wider scans of FTL's database are what make it grind.
export const QUERY_WINDOW_SECONDS = 30 * 24 * 3600
// Paging offset cap: far beyond any real "Load older" use (length <= 1000).
const MAX_QUERY_START = 10_000_000

/** Clamp a from/until timestamp into [now - 30 d, now]; undefined stays undefined. */
function clampQueryTs(v: number | undefined, now: number): number | undefined {
  if (v === undefined || Number.isNaN(v) || v === 0) return undefined
  return Math.min(now, Math.max(now - QUERY_WINDOW_SECONDS, Math.trunc(v)))
}

/**
 * Query-log page. A /queries scan is a heavy call: it runs in the node's heavy
 * lane (one at a time per node), identical concurrent requests share one node
 * call, and `signal` (the request's) cancels it once every waiter has left.
 */
export async function getQueries(
  instanceId: string,
  opts: {
    from?: number
    until?: number
    length?: number
    cursor?: string
    domain?: string
    client_ip?: string
    client_name?: string
  },
  signal?: AbortSignal
): Promise<{ queries: PiHoleQuery[]; nextCursor: string | null }> {
  // v6 paging: the first page returns `cursor` = DB id of the newest query
  // (an anchor). Later pages send that same cursor plus `start` = how many
  // rows were already shown. The code used to read `cursor.next_cursor`, which
  // doesn't exist, so "Load older" never appeared. The token handed to the UI
  // is opaque: "<anchor>:<start>".
  const length = Math.max(1, Math.min(1000, Math.trunc(opts.length ?? 50) || 50))
  const [anchor, startStr] = (opts.cursor ?? '').split(':')
  const parsedStart = parseInt(startStr ?? '', 10)
  // Bounded (R2-NV2): "1:-7" and "1:999999999999999" used to reach the node as-is.
  const start = Number.isFinite(parsedStart) ? Math.max(0, Math.min(MAX_QUERY_START, parsedStart)) : 0
  const now = Math.floor(Date.now() / 1000)
  // An `until` before the window leaves nothing to show. Clamping it up would
  // instead hand "Load older" the same page again, so answer empty, no node call.
  if (opts.until && Number.isFinite(opts.until) && opts.until < now - QUERY_WINDOW_SECONDS) {
    return { queries: [], nextCursor: null }
  }
  let from = clampQueryTs(opts.from, now)
  const until = clampQueryTs(opts.until, now)
  if (from !== undefined && until !== undefined && from > until) from = until
  const params = new URLSearchParams()
  if (from !== undefined) params.set('from', String(from))
  if (until !== undefined) params.set('until', String(until))
  params.set('length', String(length))
  if (anchor && /^\d+$/.test(anchor)) {
    params.set('cursor', anchor)
    params.set('start', String(start))
  }
  if (opts.domain) params.set('domain', opts.domain)
  if (opts.client_ip) params.set('client_ip', opts.client_ip)
  if (opts.client_name) params.set('client_name', opts.client_name)
  const path = `/queries?${params}`
  const lane = await nodeLaneKey(instanceId)
  const data = await coalesced(
    `queries\n${instanceId}\n${lane}\n${path}`,
    (shared) =>
      apiFetch<{
        queries: PiHoleQuery[]
        cursor: number | null
        recordsFiltered?: number
      }>(instanceId, path, { signal: shared }),
    { lane, signal }
  )
  const queries = data.queries ?? []
  const shown = start + queries.length
  const more =
    data.cursor != null &&
    queries.length === length &&
    (data.recordsFiltered === undefined || shown < data.recordsFiltered)
  const nextAnchor = anchor && /^\d+$/.test(anchor) ? anchor : String(data.cursor)
  return { queries, nextCursor: more ? `${nextAnchor}:${shown}` : null }
}

export async function getInstanceInfo(instanceId: string, signal?: AbortSignal): Promise<{
  version: {
    core: { local: string; remote: string }
    ftl:  { local: string; remote: string }
    web:  { local: string; remote: string }
  }
  system: {
    uptime: number
    memory: {
      ram: { used: number; total: number }
      swap: { used: number; total: number }
    }
  }
}> {
  const [ver, sys] = await Promise.all([
    apiFetch<{
      version: {
        core: { local: { version: string }; remote?: { version: string } }
        ftl:  { local: { version: string }; remote?: { version: string } }
        web:  { local: { version: string }; remote?: { version: string } }
      }
    }>(instanceId, '/info/version', { signal }),
    apiFetch<{
      system: {
        uptime: number
        memory: {
          // Pi-Hole v6 returns memory values in KB
          ram:  { used: number; total: number }
          swap: { used: number; total: number }
        }
      }
    }>(instanceId, '/info/system', { signal }),
  ])
  return {
    version: {
      core: { local: ver.version.core.local.version, remote: ver.version.core.remote?.version ?? ver.version.core.local.version },
      ftl:  { local: ver.version.ftl.local.version,  remote: ver.version.ftl.remote?.version  ?? ver.version.ftl.local.version  },
      web:  { local: ver.version.web.local.version,  remote: ver.version.web.remote?.version  ?? ver.version.web.local.version  },
    },
    system: sys.system,
  }
}
