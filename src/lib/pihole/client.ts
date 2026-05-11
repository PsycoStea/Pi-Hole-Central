import type {
  PiHoleSummary,
  TopDomain,
  TopClient,
  PiHoleSession,
  BlockingStatus,
} from './types'
import { db } from '@/lib/db'
import { instances } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { decrypt } from '@/lib/crypto'

// In-memory session cache
const sessions = new Map<string, PiHoleSession>()

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

async function authenticate(url: string, password: string): Promise<string> {
  const res = await fetch(`${url}/api/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`Auth failed: ${res.status}`)
  const data = await res.json()
  return data.session?.sid ?? data.sid
}

async function getSid(instanceId: string): Promise<{ url: string; sid: string }> {
  const config = await getInstanceConfig(instanceId)
  const cached = sessions.get(instanceId)
  if (cached && cached.expiresAt > Date.now() + 30_000) {
    return { url: config.url, sid: cached.sid }
  }
  const sid = await authenticate(config.url, config.password)
  sessions.set(instanceId, { sid, expiresAt: Date.now() + 270_000 })
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
  const sid = await authenticate(cleanUrl, password)
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
  const data = await apiFetch<{ blocked: Array<{ domain: string; count: number }> }>(
    instanceId,
    `/stats/database/top_blocked?count=${count}`
  )
  return data.blocked ?? []
}

export async function getTopClients(instanceId: string, count = 10): Promise<TopClient[]> {
  const data = await apiFetch<{
    clients: Array<{ ip: string; name: string; count: number }>
  }>(instanceId, `/stats/database/top_clients?count=${count}`)
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
  list: 'allow' | 'deny'
): Promise<void> {
  await apiFetch(instanceId, `/domains/${list}`, {
    method: 'POST',
    body: JSON.stringify({ domain }),
  })
}

export async function removeDomain(
  instanceId: string,
  domain: string,
  list: 'allow' | 'deny'
): Promise<void> {
  await apiFetch(instanceId, `/domains/${list}/${encodeURIComponent(domain)}`, {
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

export async function getQueryHistory(
  instanceId: string,
  from: number,
  to: number
): Promise<{ timestamp: number; total: number; blocked: number }[]> {
  const data = await apiFetch<{
    history: Array<{ timestamp: number; total_queries: number; blocked_queries: number }>
  }>(instanceId, `/history?from=${from}&until=${to}`)
  return (data.history ?? []).map((h) => ({
    timestamp: h.timestamp,
    total: h.total_queries,
    blocked: h.blocked_queries,
  }))
}
