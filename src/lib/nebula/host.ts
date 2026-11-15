import { db } from '@/lib/db'
import { appSettings } from '@/lib/db/schema'
import { inArray } from 'drizzle-orm'
import { connectSSH } from '@/lib/ssh/client'
import { coalescedCache } from '@/lib/nebula/coalesced-cache'
import type { NodeSSH } from 'node-ssh'

// Live status of the nebula-sync container, read over SSH from its host. This
// complements the config-drift check (drift.ts): drift says "are the nodes in
// sync?", this says "is the syncer actually running?".

export type NebulaHostStatus = {
  configured: boolean
  reachable: boolean
  container: { name: string; status: string; health: string; startedAt: string } | null
  recentLogs: string[]
  error?: string
}

type NebulaHostConfig = { host: string; user: string; container: string }

async function readConfig(): Promise<NebulaHostConfig> {
  const rows = await db.query.appSettings.findMany({
    where: inArray(appSettings.key, ['nebula_host', 'nebula_ssh_user', 'nebula_container']),
  })
  const get = (k: string) => (rows.find((r) => r.key === k)?.value ?? '').trim()
  return {
    host: get('nebula_host'),
    user: get('nebula_ssh_user') || 'root',
    container: safeContainer(get('nebula_container') || 'nebula-sync'),
  }
}

// Every refresh opens a root SSH session to the nebula host, so: one at a time
// (coalesced), cached for 60 s, and a forced refresh (admin Refresh button) at
// most every 10 s. Keyed by the host settings so saving a new host is picked up
// at once (audit R2-NV1).
const CACHE_TTL_MS = 60_000
const MIN_REFRESH_MS = 10_000
const cache = coalescedCache<NebulaHostStatus>('__piholeCentralNebulaHostV2', {
  ttlMs: CACHE_TTL_MS,
  minRefreshMs: MIN_REFRESH_MS,
})

// docker object names: [A-Za-z0-9][A-Za-z0-9_.-]* — reject anything else since
// it's interpolated into a shell command over SSH.
function safeContainer(name: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name) ? name : 'nebula-sync'
}

async function compute({ host, user, container }: NebulaHostConfig): Promise<NebulaHostStatus> {
  if (!host) {
    return { configured: false, reachable: false, container: null, recentLogs: [] }
  }

  let ssh: NodeSSH | null = null
  try {
    ssh = await connectSSH({ host, username: user, passwordEncrypted: null })
    const insp = await ssh.execCommand(
      `docker inspect ${container} --format '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}|{{.State.StartedAt}}'`
    )
    if (insp.code !== 0) {
      return { configured: true, reachable: true, container: null, recentLogs: [], error: insp.stderr || `container "${container}" not found` }
    }
    const [status = 'unknown', health = '', startedAt = ''] = insp.stdout.trim().split('|')
    const logs = await ssh.execCommand(`docker logs --tail 15 ${container} 2>&1`)
    return {
      configured: true,
      reachable: true,
      container: { name: container, status, health, startedAt },
      recentLogs: logs.stdout.split('\n').filter(Boolean).slice(-15),
    }
  } catch (err) {
    return {
      configured: true,
      reachable: false,
      container: null,
      recentLogs: [],
      error: err instanceof Error ? err.message : 'SSH connection failed',
    }
  } finally {
    if (ssh) ssh.dispose()
  }
}

export async function getNebulaHostStatus(force = false): Promise<NebulaHostStatus> {
  const cfg = await readConfig()
  return cache.get(`${cfg.host}|${cfg.user}|${cfg.container}`, force, () => compute(cfg))
}

/**
 * The status as non-admin sessions may see it: container state and health, but
 * not the raw `docker logs` lines (they come verbatim from a root shell on the
 * nebula host and could echo the Pi-hole passwords nebula-sync is configured
 * with; audit R3A-NV2) nor the raw remote error text. Returns a copy: the cached
 * object is shared with admins.
 */
export function redactForViewer(status: NebulaHostStatus): NebulaHostStatus {
  return {
    configured: status.configured,
    reachable: status.reachable,
    container: status.container,
    recentLogs: [],
    ...(status.error ? { error: status.reachable ? 'Container status unavailable' : 'Nebula host unreachable' } : {}),
  }
}
