import type {
  PiHoleSummary,
  TopDomain,
  TopClient,
  PiHoleSession,
  BlockingStatus,
  PiHoleQuery,
  Domain,
  Group,
} from './types'
import { db } from '@/lib/db'
import { instances } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { decrypt } from '@/lib/crypto'

// In-memory session cache
const sessions = new Map<string, PiHoleSession>()
// Deduplicates concurrent auth requests for the same instance
const pendingAuth = new Map<string, Promise<{ sid: string; expiresAt: number }>>()

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

async function authenticate(url: string, password: string): Promise<{ sid: string; expiresAt: number }> {
  const res = await fetch(`${url}/api/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`Auth failed: ${res.status}`)
  const data = await res.json()
  const sid = data.session?.sid ?? data.sid
  // Use Pi-Hole's reported validity minus a 50s safety margin; fall back to 1750s
  const validity: number = data.session?.validity ?? 1800
  const expiresAt = Date.now() + (validity - 50) * 1000
  return { sid, expiresAt }
}

async function getSid(instanceId: string): Promise<{ url: string; sid: string }> {
  const config = await getInstanceConfig(instanceId)
  const cached = sessions.get(instanceId)
  if (cached && cached.expiresAt > Date.now() + 30_000) {
    return { url: config.url, sid: cached.sid }
  }

  // Deduplicate: if an auth request is already in-flight for this instance, wait for it
  let pending = pendingAuth.get(instanceId)
  if (!pending) {
    pending = authenticate(config.url, config.password).then(
      (result) => {
        sessions.set(instanceId, result)
        pendingAuth.delete(instanceId)
        return result
      },
      (err) => {
        pendingAuth.delete(instanceId)
        throw err
      }
    )
    pendingAuth.set(instanceId, pending)
  }

  const { sid } = await pending
  return { url: config.url, sid }
}

async function apiFetch<T>(
  instanceId: string,
  path: string,
  options?: RequestInit,
  retry = true
): Promise<T> {
  const { url, sid } = await getSid(instanceId)
  const res = await fetch(`${url}/api${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-FTL-SID': sid,
      ...options?.headers,
    },
    signal: AbortSignal.timeout(10_000),
  })
  if (res.status === 401 && retry) {
    sessions.delete(instanceId)
    return apiFetch(instanceId, path, options, false)
  }
  if (!res.ok) throw new Error(`Pi-Hole API error ${res.status} on ${path}`)
  return res.json()
}

export async function testConnection(url: string, password: string): Promise<PiHoleSummary> {
  const cleanUrl = url.replace(/\/$/, '')
  const { sid } = await authenticate(cleanUrl, password)
  const res = await fetch(`${cleanUrl}/api/stats/summary`, {
    headers: { 'X-FTL-SID': sid },
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`Connection test failed: ${res.status}`)
  return res.json()
}

export async function getSummary(instanceId: string): Promise<PiHoleSummary> {
  return apiFetch<PiHoleSummary>(instanceId, '/stats/summary')
}

export async function getTopDomains(instanceId: string, count = 10): Promise<TopDomain[]> {
  const data = await apiFetch<{ domains: Array<{ domain: string; count: number }> }>(
    instanceId,
    `/stats/top_domains?count=${count}`
  )
  return data.domains ?? []
}

export async function getTopClients(instanceId: string, count = 10): Promise<TopClient[]> {
  const data = await apiFetch<{
    clients: Array<{ ip: string; name: string; count: number }>
  }>(instanceId, `/stats/top_clients?count=${count}`)
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
  await apiFetch(instanceId, `/domains/${list}/${kind}`, {
    method: 'POST',
    body: JSON.stringify({ domain, comment, groups, enabled }),
  })
}

export async function removeDomain(
  instanceId: string,
  list: 'allow' | 'deny',
  kind: string,
  id: number
): Promise<void> {
  await apiFetch(instanceId, `/domains/${list}/${kind}/${id}`, {
    method: 'DELETE',
  })
}

export async function triggerGravity(instanceId: string): Promise<void> {
  const { url, sid } = await getSid(instanceId)
  await fetch(`${url}/api/action/gravity`, {
    method: 'POST',
    headers: { 'X-FTL-SID': sid },
    signal: AbortSignal.timeout(60_000),
  })
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

// Long-term: database history with from/until Unix timestamps in seconds
export async function getQueryHistoryRange(
  instanceId: string,
  from: number,
  to: number
): Promise<{ timestamp: number; total: number; blocked: number }[]> {
  const data = await apiFetch<{
    history: Array<{ timestamp: number; total: number; blocked: number }>
  }>(instanceId, `/history/database?from=${from}&until=${to}`)
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

export async function getGroups(instanceId: string): Promise<Group[]> {
  const data = await apiFetch<{ groups: Group[] }>(instanceId, '/groups')
  return data.groups ?? []
}

export async function getQueries(
  instanceId: string,
  opts: {
    from?: number
    until?: number
    length?: number
    cursor?: string
    domain?: string
    client_ip?: string
  }
): Promise<{ queries: PiHoleQuery[]; nextCursor: string | null }> {
  const params = new URLSearchParams()
  if (opts.from) params.set('from', String(opts.from))
  if (opts.until) params.set('until', String(opts.until))
  params.set('length', String(opts.length ?? 50))
  if (opts.cursor) params.set('cursor', opts.cursor)
  if (opts.domain) params.set('domain', opts.domain)
  if (opts.client_ip) params.set('client_ip', opts.client_ip)
  const data = await apiFetch<{
    queries: PiHoleQuery[]
    cursor: { next_cursor: string | null }
  }>(instanceId, `/queries?${params}`)
  return { queries: data.queries ?? [], nextCursor: data.cursor?.next_cursor ?? null }
}

export async function getInstanceInfo(instanceId: string): Promise<{
  version: { core: string; ftl: string; web: string }
  system: {
    uptime: number
    memory: {
      ram: { used: number; total: number }
      swap: { used: number; total: number }
    }
  }
}> {
  const [ver, sys] = await Promise.all([
    apiFetch<{ version: { core: string; ftl: string; web: string } }>(instanceId, '/info/version'),
    apiFetch<{
      system: {
        uptime: number
        memory: {
          ram: { used: number; total: number }
          swap: { used: number; total: number }
        }
      }
    }>(instanceId, '/info/system'),
  ])
  return { version: ver.version, system: sys.system }
}
