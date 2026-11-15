export interface PiHoleSummary {
  queries: {
    total: number
    blocked: number
    percent_blocked: number
    unique_domains: number
    forwarded: number
    cached: number
  }
  clients: {
    active: number
    total: number
  }
  gravity: {
    domains_being_blocked: number
    // v6 shape (was the v5 `last_updated: { absolute }`; nothing read it).
    last_update: number
  }
  // NOTE: no `blocking` here. Pi-hole v6 `/api/stats/summary` returns only
  // { queries, clients, gravity, took } — blocking state lives on
  // `/api/dns/blocking` (see getBlockingStatus). This interface used to declare
  // `blocking`, so `summary.blocking !== 'enabled'` compiled cleanly while
  // being `undefined` at runtime, making the blocking_disabled alert fire
  // forever on healthy nodes.
}

export interface TopDomain {
  domain: string
  count: number
}

export interface TopClient {
  ip: string
  name: string
  count: number
}

export interface PiHoleSession {
  /** The node URL that issued this SID; it is only ever sent back there (R3A-D1). */
  url: string
  sid: string
  expiresAt: number
}

export interface PiHoleInstanceConfig {
  id: string
  url: string
  password: string
}

export interface BlockingStatus {
  blocking: 'enabled' | 'disabled' | 'failed' | 'unknown'
  timer: number | null
}

export interface PiHoleQuery {
  id: number
  time: number
  type: string
  domain: string
  client: { ip: string; name: string | null }
  status: string
  reply: { type: string; time: number }
  upstream: string | null
}

export interface Domain {
  id: number
  domain: string
  kind: 'exact' | 'regex'
  comment: string
  enabled: boolean
  groups: number[]
}

export interface Group {
  id: number
  name: string
  comment: string | null
  enabled: boolean
}

export interface Client {
  id: number
  client: string // IP, MAC, hostname, or subnet
  comment: string | null
  groups: number[]
  name?: string | null // resolved hostname (read-only, from Pi-hole)
}

export interface AdList {
  id: number
  address: string
  comment: string
  enabled: boolean
  groups: number[]
  date_modified?: number
}
