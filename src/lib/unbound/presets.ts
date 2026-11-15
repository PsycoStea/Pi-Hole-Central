export const DNS_PRESETS = {
  quad9:      ['9.9.9.9@853#dns.quad9.net', '149.112.112.112@853#dns.quad9.net'],
  cloudflare: ['1.1.1.1@853#cloudflare-dns.com', '1.0.0.1@853#cloudflare-dns.com'],
  google:     ['8.8.8.8@853#dns.google', '8.8.4.4@853#dns.google'],
  adguard:    ['94.140.14.14@853#dns.adguard-dns.com', '94.140.15.15@853#dns.adguard-dns.com'],
} as const

export type DnsPreset = keyof typeof DNS_PRESETS

export const PRESET_LABELS: Record<DnsPreset, string> = {
  quad9:      'Quad9',
  cloudflare: 'Cloudflare',
  google:     'Google',
  adguard:    'AdGuard',
}

export function detectPreset(addrs: string[]): DnsPreset | 'custom' {
  const sorted = [...addrs].sort().join(',')
  for (const key of Object.keys(DNS_PRESETS) as DnsPreset[]) {
    if ([...DNS_PRESETS[key]].sort().join(',') === sorted) return key
  }
  return 'custom'
}

// --- Forward-address validation -------------------------------------------
// Unbound forward-addr syntax: IP[@port][#tls-hostname]
// e.g. "9.9.9.9@853#dns.quad9.net" or "2620:fe::fe@853#dns.quad9.net".
// These addresses are interpolated into an `unbound-control forward .` shell
// command run over SSH on the Pi-hole nodes, so validation here is a security
// boundary, not just UX: the accepted character set must exclude every shell
// metacharacter (; | & $ ` ( ) < > space etc.). Do NOT loosen without care.

function isValidIpv4(s: string): boolean {
  const parts = s.split('.')
  if (parts.length !== 4) return false
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
}

function isValidIpv6(s: string): boolean {
  // Only hex groups and colons; must contain at least one colon. Structural
  // rather than fully RFC-strict, but it rejects anything non-address-like.
  if (!s.includes(':')) return false
  if (!/^[0-9a-fA-F:]+$/.test(s)) return false
  return (s.match(/:/g)?.length ?? 0) <= 7
}

export function isValidForwardAddr(addr: string): boolean {
  if (typeof addr !== 'string') return false
  const trimmed = addr.trim()
  if (!trimmed || trimmed.length > 253) return false

  // Peel off optional #tls-hostname
  let rest = trimmed
  const hashIdx = rest.indexOf('#')
  if (hashIdx !== -1) {
    const hostname = rest.slice(hashIdx + 1)
    if (!/^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(hostname)) return false
    rest = rest.slice(0, hashIdx)
  }

  // Peel off optional @port
  const atIdx = rest.indexOf('@')
  if (atIdx !== -1) {
    const port = rest.slice(atIdx + 1)
    if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) return false
    rest = rest.slice(0, atIdx)
  }

  return isValidIpv4(rest) || isValidIpv6(rest)
}

/** Returns the subset of addrs that fail validation (empty = all valid). */
export function invalidForwardAddrs(addrs: string[]): string[] {
  return addrs.filter((a) => !isValidForwardAddr(a))
}

/**
 * Applying upstreams from the dashboard is switched off (2026-11-06 review).
 * It used `unbound-control forward .`, which (1) changes only the running
 * server, so any restart silently reverts it; (2) went to every node at once
 * with no health probe or rollback; and (3) builds a fresh root delegation that
 * very likely loses `forward-tls-upstream: yes`, which these nodes set per zone,
 * so the DoT presets would send plain DNS to port 853 and break resolution on
 * both nodes together. Re-enable only after a rewrite that writes a conf.d file,
 * runs unbound-checkconf, reloads, probes, and rolls back — replica first.
 */
export const UPSTREAM_APPLY_ENABLED: boolean = false
export const UPSTREAM_APPLY_DISABLED =
  'Changing upstreams from the dashboard is disabled until it can be done safely (persisted, validated, one node at a time with rollback). Edit the forward-zone in /etc/unbound/unbound.conf on the node instead.'
