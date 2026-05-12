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
    last_updated: { absolute: number }
  }
  blocking: 'enabled' | 'disabled' | 'unknown'
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
  sid: string
  expiresAt: number
}

export interface PiHoleInstanceConfig {
  id: string
  url: string
  password: string
}

export interface BlockingStatus {
  blocking: 'enabled' | 'disabled' | 'unknown'
  timer: number | null
}

export interface PiHoleQuery {
  id: number
  time: number
  type: string
  domain: string
  client: { ip: string; name: string }
  status: string
  reply: { type: string; time: number }
  upstream: string | null
}
