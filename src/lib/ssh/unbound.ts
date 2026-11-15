import { NodeSSH } from 'node-ssh'
import { invalidForwardAddrs } from '@/lib/unbound/presets'

export { DNS_PRESETS, type DnsPreset } from '@/lib/unbound/presets'

export type UnboundStats = {
  uptimeSeconds: number
  totalQueries: number
  cacheHits: number
  cacheMisses: number
  cacheHitRate: number
  avgRecursionMs: number
  servfailCount: number
  memoryCacheBytes: number
}

export type DotHealthResult = {
  ok: boolean
  /** Resolver response time for a (normally cached) name — what the latency alert tracks. */
  latencyMs: number | null
  /** Round trip of the uncached upstream probe over DoT, for display. */
  upstreamMs?: number | null
  error?: string
}

export type UnboundCheck =
  | { state: 'running' }
  | { state: 'stopped'; detail: string }
  | { state: 'not_answering'; detail: string }

const STOPPED_MARK = '__PC_UNBOUND_STOPPED__'

/**
 * Is Unbound up AND answering, in one SSH round trip (the Pi Zero replica is
 * slow to open sessions, so this runs as a single command every minute).
 *
 * The answer check asks Unbound for `localhost`, which it serves from its own
 * built-in local zone: it never goes upstream, so a slow or unreachable DoT
 * upstream cannot make this fail. Only a stopped, crashed or hung Unbound does.
 * (Upstream failure is a different problem, not covered here.)
 */
export async function checkUnbound(ssh: NodeSSH): Promise<UnboundCheck> {
  const result = await ssh.execCommand(
    `state=$(systemctl is-active unbound 2>&1) || { echo "${STOPPED_MARK} $state"; exit 0; }; ` +
      'dig @127.0.0.1 -p 5335 localhost A +time=2 +tries=1'
  )
  const out = result.stdout
  const stoppedAt = out.indexOf(STOPPED_MARK)
  if (stoppedAt !== -1) {
    const state = out.slice(stoppedAt + STOPPED_MARK.length).trim().split('\n')[0] || 'not active'
    return { state: 'stopped', detail: `systemctl reports "${state}"` }
  }
  const status = digStatus(out)
  if (status === 'NOERROR') return { state: 'running' }
  const reason = status
    ? `answered ${status}`
    : (out.match(/;; (.*(?:timed out|refused|error).*)/i)?.[1] ?? (result.stderr || out).trim().slice(0, 200)) || 'no answer'
  return { state: 'not_answering', detail: `local query on port 5335: ${reason}` }
}

export async function getUnboundStats(ssh: NodeSSH): Promise<UnboundStats> {
  const result = await ssh.execCommand('sudo unbound-control stats_noreset')
  const flat = result.stdout.split('\n').reduce<Record<string, string>>((acc, line) => {
    const eq = line.indexOf('=')
    if (eq > 0) acc[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
    return acc
  }, {})
  const get = (k: string) => parseFloat(flat[k] ?? '0') || 0
  const totalQueries = get('total.num.queries')
  const cacheHits = get('total.num.cachehits')
  return {
    uptimeSeconds: get('time.up'),
    totalQueries,
    cacheHits,
    cacheMisses: get('total.num.cachemiss'),
    cacheHitRate: totalQueries > 0 ? cacheHits / totalQueries : 0,
    avgRecursionMs: get('total.recursion.time.avg') * 1000,
    servfailCount: get('num.answer.rcode.SERVFAIL'),
    memoryCacheBytes: get('mem.cache.rrset'),
  }
}

export async function getUnboundLogs(ssh: NodeSSH, n: number): Promise<string[]> {
  const result = await ssh.execCommand(`journalctl -u unbound -n ${n} --no-pager`)
  return result.stdout.split('\n').filter(Boolean)
}

/**
 * Restart Unbound, but only if its config validates. Restarting with a broken
 * unbound.conf (e.g. after a hand edit) leaves the node with no DNS at all.
 */
export async function restartUnbound(ssh: NodeSSH): Promise<{ code: number; error?: string }> {
  // Unprivileged on purpose: the SSH user's NOPASSWD sudo covers systemctl and
  // unbound-control but not unbound-checkconf (sudo -n would always fail), and
  // the config is world-readable. Full path: /usr/sbin isn't on its PATH.
  const check = await ssh.execCommand('/usr/sbin/unbound-checkconf')
  if (check.code !== 0) {
    return { code: check.code ?? -1, error: `unbound-checkconf failed, not restarting: ${(check.stderr || check.stdout).trim().slice(0, 300)}` }
  }
  const result = await ssh.execCommand('sudo systemctl restart unbound')
  return { code: result.code ?? -1, error: result.code === 0 ? undefined : result.stderr.trim().slice(0, 300) }
}

export async function getForwardConfig(ssh: NodeSSH): Promise<{ forwardAddrs: string[] }> {
  const result = await ssh.execCommand('cat /etc/unbound/unbound.conf')
  const forwardAddrs = result.stdout
    .split('\n')
    .map((l) => l.match(/^\s+forward-addr:\s+(.+)/))
    .filter(Boolean)
    .map((m) => m![1].trim())
  return { forwardAddrs }
}

export async function applyForwardZone(ssh: NodeSSH, addrs: string[]): Promise<void> {
  // Defense in depth: these values are interpolated into a shell command on the
  // remote node. Reject anything that is not a strict IP[@port][#hostname] even
  // though the API routes validate too — this function must be safe on its own.
  if (addrs.length === 0) throw new Error('No forward addresses provided')
  const bad = invalidForwardAddrs(addrs)
  if (bad.length > 0) {
    throw new Error(`Invalid forward address(es): ${bad.join(', ')}`)
  }
  const result = await ssh.execCommand(`sudo unbound-control forward . ${addrs.join(' ')}`)
  if (result.code !== 0) throw new Error(result.stderr || `exit code ${result.code}`)
}

export async function flushUnboundCache(ssh: NodeSSH): Promise<void> {
  const result = await ssh.execCommand('sudo unbound-control flush_zone .')
  if (result.code !== 0) throw new Error(result.stderr || `exit code ${result.code}`)
}

export async function setUnboundVerbosity(ssh: NodeSSH, level: number): Promise<void> {
  const result = await ssh.execCommand(`sudo unbound-control verbosity ${level}`)
  if (result.code !== 0) throw new Error(result.stderr || `exit code ${result.code}`)
}

const digStatus = (out: string) => /status:\s*([A-Z]+)/.exec(out)?.[1] ?? null
const digTime = (out: string) => {
  const m = /Query time:\s+(\d+)\s+msec/.exec(out)
  return m ? parseInt(m[1], 10) : null
}

/**
 * DoT/recursor health.
 *
 * "ok" comes from a probe Unbound cannot answer from cache: a random label
 * under google.com (unsigned, so no aggressive-NSEC synthesis), which must be
 * fetched from the upstream over TLS. NXDOMAIN and NOERROR both prove the
 * upstream answered. The old check used `dig` exit status, which is 0 even for
 * SERVFAIL — the exact answer a broken TLS upstream produces — and queried
 * cloudflare.com, which is nearly always cached, so it reported healthy when
 * the upstream was down.
 *
 * latencyMs keeps its old meaning (a cached lookup, ~3ms on these nodes) so the
 * latency_high thresholds stay valid; the real upstream round trip (~165ms over
 * DoT on 2026-11-06) is reported separately as upstreamMs.
 *
 * The cached lookup runs twice and the second is timed. When cloudflare.com's
 * entry (TTL 300s) had just expired, a single lookup paid the full DoT round
 * trip and tripped latency_high: all three alerts ever raised (151, 160, 191ms,
 * 2026-11-03..07, both nodes) were that, each clearing on the next check.
 */
export async function testDotHealth(ssh: NodeSSH): Promise<DotHealthResult> {
  const nonce = `pc-health-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  const probe = await ssh.execCommand(`dig @127.0.0.1 -p 5335 ${nonce}.google.com +time=5 +tries=1`)
  const status = digStatus(probe.stdout)
  if (status !== 'NOERROR' && status !== 'NXDOMAIN') {
    return {
      ok: false,
      latencyMs: null,
      error: status ? `upstream probe returned ${status}` : (probe.stderr || probe.stdout).trim().slice(0, 200) || 'dig failed',
    }
  }
  // First lookup refills the cache if the entry expired; time the second.
  const CACHED = 'dig @127.0.0.1 -p 5335 cloudflare.com +time=3 +tries=1'
  const cached = await ssh.execCommand(`${CACHED} >/dev/null; ${CACHED}`)
  return {
    ok: true,
    latencyMs: digStatus(cached.stdout) === 'NOERROR' ? digTime(cached.stdout) : null,
    upstreamMs: digTime(probe.stdout),
  }
}
