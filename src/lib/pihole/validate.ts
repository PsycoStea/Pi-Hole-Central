/**
 * Input checks for values the API routes forward to Pi-hole. Admin-only routes,
 * so this is about not sending junk (NaN, negative timers, file:// lists, path
 * fragments) to the nodes rather than about hostile users.
 */

/** Blocklists must be fetched over http(s). v6 gravity also accepts file://, which would read local files into gravity. */
export function isHttpUrl(v: unknown): v is string {
  if (typeof v !== 'string') return false
  try {
    const u = new URL(v.trim())
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/** Pi-hole group ids: a non-empty array of non-negative integers. */
export function isGroupIds(v: unknown): v is number[] {
  return Array.isArray(v) && v.length > 0 && v.every((g) => Number.isInteger(g) && g >= 0)
}

/** A domain or regex entry: non-empty, no whitespace, sane length. */
export function isDomainEntry(v: unknown): v is string {
  // "." and ".." can never be addressed again through the API path (fetch
  // normalises them away), so a temp entry like that could never be reverted.
  return typeof v === 'string' && v.length > 0 && v.length <= 253 * 2 && !/\s/.test(v) && v !== '.' && v !== '..'
}

export function isList(v: unknown): v is 'allow' | 'deny' {
  return v === 'allow' || v === 'deny'
}

export function isKind(v: unknown): v is 'exact' | 'regex' {
  return v === 'exact' || v === 'regex'
}

/** Parse an integer query param, falling back to `def` and clamping to [min, max]. */
export function intParam(raw: string | null, def: number, min: number, max: number): number {
  const n = raw === null ? NaN : parseInt(raw, 10)
  if (!Number.isFinite(n)) return def
  return Math.max(min, Math.min(max, n))
}

/**
 * SSRF guard: this endpoint fetches a caller-supplied URL server-side. Pi-hole
 * nodes live on the LAN, so restrict to http(s) with an IP host in a private or
 * loopback range. Hostnames are allowed (admin-configured, may be internal DNS
 * names), but public IP literals, link-local (169.254/16 — cloud metadata),
 * IPv6 literals, and anything beyond the origin (path, query, fragment) are
 * rejected.
 */
export function isAllowedInstanceUrl(raw: string): boolean {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  if (u.username || u.password) return false
  // Origin only: every request is built as `${url}/api/...`, so a path, query
  // or fragment would change where it lands (run-3a hardening note). The
  // routes strip one trailing slash before calling this.
  if (u.pathname !== '/' || u.search !== '' || u.hash !== '') return false
  if (/[?#]/.test(raw)) return false // "http://h/?" and "http://h/#" parse to empty search/hash

  const host = u.hostname
  // IPv6 literals ([::ffff:169.254.169.254], [fe80::1], ...) slipped past the
  // IPv4 check below and were allowed as "hostnames". The nodes are IPv4 LAN
  // hosts or DNS names, so refuse IPv6 literals outright.
  if (host.startsWith('[') || host.includes(':')) return false
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])]
    if (a === 10) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 127) return true
    return false // any other IP literal (incl. 169.254 link-local, public) is rejected
  }
  // Non-IP hostname — allowed (admin-trusted, internal DNS).
  return true
}
