'use client'

import { useEffect, useState, useCallback, useRef, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { Button } from '@/components/ui/button'

import PageHeader from '@/components/dashboard/PageHeader'

interface PiHoleQuery {
  id: number
  time: number
  type: string
  domain: string
  client: { ip: string; name: string }
  status: string
  reply: { type: string; time: number }
  upstream: string | null
}

interface QueryRow extends PiHoleQuery {
  instanceId?: string
  instanceName?: string
}

interface Instance {
  id: string
  name: string
}

type StatusCategory = 'all' | 'blocked' | 'cached' | 'forwarded'

const STATUS_FILTERS: { label: string; value: StatusCategory; color: string }[] = [
  { label: 'All', value: 'all', color: 'bg-foreground/15 text-foreground' },
  { label: 'Blocked', value: 'blocked', color: 'bg-destructive/20 text-destructive' },
  { label: 'Cached', value: 'cached', color: 'bg-primary/20 text-primary' },
  { label: 'Forwarded', value: 'forwarded', color: 'bg-success/20 text-success' },
]

function formatTime(unix: number) {
  return new Date(unix * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

// Pi-hole v6 query statuses, grouped the way Pi-hole's own query log does
// (admin/scripts/js/queries.js). Matching by substring used to file
// GRAVITY_CNAME, REGEX and DENYLIST blocks under "forwarded".
const BLOCKED_STATUSES = new Set([
  'GRAVITY', 'REGEX', 'DENYLIST',
  'GRAVITY_CNAME', 'REGEX_CNAME', 'DENYLIST_CNAME',
  'EXTERNAL_BLOCKED_IP', 'EXTERNAL_BLOCKED_NULL', 'EXTERNAL_BLOCKED_NXRA',
  'EXTERNAL_BLOCKED_EDE15', 'QUERY_EXTERNAL_BLOCKED_EDE15',
  'SPECIAL_DOMAIN',
])
const CACHED_STATUSES = new Set(['CACHE', 'CACHE_STALE'])
const FORWARDED_STATUSES = new Set(['FORWARDED', 'RETRIED', 'RETRIED_DNSSEC', 'IN_PROGRESS'])

function classifyStatus(status: string): 'blocked' | 'cached' | 'forwarded' | 'other' {
  const s = (status ?? '').toUpperCase()
  if (BLOCKED_STATUSES.has(s)) return 'blocked'
  if (CACHED_STATUSES.has(s)) return 'cached'
  if (FORWARDED_STATUSES.has(s)) return 'forwarded'
  return 'other'
}

/** Turn what the user typed into a Pi-hole filter: substring match unless
 *  they used * themselves (Pi-hole matches exactly without wildcards). */
function wildcard(term: string): string {
  const t = term.trim()
  return t.includes('*') ? t : `*${t}*`
}

/** Client box: an IP (or IP pattern) filters client_ip, anything else the hostname. */
function clientFilter(term: string): { client_ip?: string; client_name?: string } {
  const t = term.trim()
  if (!t) return {}
  if (/^[0-9.*]+$/.test(t) && t.includes('.')) return { client_ip: t }
  if (/^[0-9a-f:*]+$/i.test(t) && t.includes(':')) return { client_ip: t }
  return { client_name: wildcard(t) }
}

function StatusBadge({ status }: { status: string }) {
  const cat = classifyStatus(status)
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
      cat === 'blocked'   ? 'bg-destructive/15 text-destructive' :
      cat === 'cached'    ? 'bg-primary/15 text-primary' :
      cat === 'forwarded' ? 'bg-success/15 text-success' :
                            'bg-warning/15 text-warning'
    }`}>
      {status}
    </span>
  )
}

function QueryLogContent() {
  const searchParams = useSearchParams()

  const [instances, setInstances] = useState<Instance[]>([])
  const [selectedInstance, setSelectedInstance] = useState<string>('')

  const [domainInput, setDomainInput] = useState('')
  const [clientInput, setClientInput] = useState(searchParams.get('client') ?? '')
  // The domain/client filters are sent to Pi-hole (so they search its whole
  // log, not just the rows already loaded). Applied on Enter, Refresh, or
  // after a short pause in typing.
  const [applied, setApplied] = useState({ domain: '', client: searchParams.get('client') ?? '' })
  useEffect(() => {
    const next = { domain: domainInput.trim(), client: clientInput.trim() }
    // Keep the same object when nothing changed, or every pause would refetch.
    const t = setTimeout(() => setApplied((prev) => (prev.domain === next.domain && prev.client === next.client ? prev : next)), 600)
    return () => clearTimeout(t)
  }, [domainInput, clientInput])
  const [error, setError] = useState<string | null>(null)

  const [statusFilter, setStatusFilter] = useState<StatusCategory>('all')
  const [queries, setQueries] = useState<QueryRow[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [oldestTimestamp, setOldestTimestamp] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)

  const fetchIdRef = useRef(0)
  const isAllInstances = selectedInstance === '__all__'

  useEffect(() => {
    // Only ids/names are needed: /api/instances makes no node calls (P5.8).
    fetch('/api/instances')
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: { id: string; name: string; enabled?: boolean }[]) => {
        const insts: Instance[] = (Array.isArray(rows) ? rows : []).filter((i) => i.enabled).map((i) => ({
          id: i.id,
          name: i.name,
        }))
        setInstances(insts)
        const paramInstance = searchParams.get('instance')
        if (paramInstance && insts.find((i) => i.id === paramInstance)) {
          setSelectedInstance(paramInstance)
        } else {
          setSelectedInstance(insts.length > 1 ? '__all__' : (insts[0]?.id ?? ''))
        }
      })
      .catch(() => {})
  }, [searchParams])

  const fetchQueries = useCallback(
    async (opts?: { cursor?: string; until?: number }) => {
      if (!selectedInstance) return
      const isLoadMore = !!(opts?.cursor || opts?.until)
      isLoadMore ? setLoadingMore(true) : setLoading(true)

      const fetchId = ++fetchIdRef.current
      const now = Math.floor(Date.now() / 1000)

      const params = new URLSearchParams({
        until: opts?.until ? String(opts.until) : String(now),
        length: isAllInstances ? '100' : '50',
      })
      if (opts?.cursor) params.set('cursor', opts.cursor)
      if (applied.domain) params.set('domain', wildcard(applied.domain))
      for (const [k, v] of Object.entries(clientFilter(applied.client))) if (v) params.set(k, v)

      const url = isAllInstances
        ? `/api/pihole/queries?${params}`
        : `/api/pihole/${selectedInstance}/queries?${params}`

      try {
        const res = await fetch(url)
        if (fetchId !== fetchIdRef.current) return
        const data = await res.json().catch(() => ({}))
        if (!res.ok) {
          setError(data.error ?? `Could not load queries (HTTP ${res.status})`)
          return
        }
        setError(
          data.failures?.length
            ? `Missing results from ${data.failures.map((f: { name: string; error: string }) => `${f.name} (${f.error})`).join(', ')}`
            : null
        )

        if (isAllInstances) {
          setQueries((prev) => isLoadMore ? [...prev, ...(data.queries ?? [])] : (data.queries ?? []))
          setOldestTimestamp(data.oldestTimestamp ?? null)
          setNextCursor(null)
        } else {
          setQueries((prev) => isLoadMore ? [...prev, ...(data.queries ?? [])] : (data.queries ?? []))
          setNextCursor(data.nextCursor ?? null)
          setOldestTimestamp(null)
        }
      } catch {
        if (fetchId === fetchIdRef.current) setError('Network error loading queries')
      } finally {
        if (fetchId === fetchIdRef.current) {
          isLoadMore ? setLoadingMore(false) : setLoading(false)
        }
      }
    },
    [selectedInstance, isAllInstances, applied]
  )

  useEffect(() => {
    if (selectedInstance) {
      setQueries([])
      setNextCursor(null)
      setOldestTimestamp(null)
      fetchQueries()
    }
  }, [selectedInstance, fetchQueries])

  function handleRefresh() {
    const next = { domain: domainInput.trim(), client: clientInput.trim() }
    if (next.domain !== applied.domain || next.client !== applied.client) {
      setApplied(next) // the effect above refetches from the top
      return
    }
    setQueries([])
    setNextCursor(null)
    setOldestTimestamp(null)
    fetchQueries()
  }

  function handleLoadMore() {
    if (isAllInstances && oldestTimestamp) {
      fetchQueries({ until: oldestTimestamp - 1 })
    } else if (nextCursor) {
      fetchQueries({ cursor: nextCursor })
    }
  }

  const hasMore = isAllInstances ? !!oldestTimestamp : !!nextCursor

  // Domain/client are filtered by Pi-hole; the status buttons narrow the
  // rows already loaded (a category spans many v6 statuses).
  const visibleQueries = queries.filter(
    (q) => statusFilter === 'all' || classifyStatus(q.status) === statusFilter
  )

  return (
    <div className="space-y-6">
      <PageHeader title="Query Log" description="DNS queries from your Pi-Hole instances" />

      {/* Filters */}
      <div className="surface p-4 space-y-3">
        <div className="flex flex-wrap gap-3 items-end">
          {/* Instance selector */}
          <div className="flex flex-col gap-1">
            <label htmlFor="ql-instance" className="text-xs text-muted-foreground">Instance</label>
            <select
              id="ql-instance"
              value={selectedInstance}
              onChange={(e) => {
                setSelectedInstance(e.target.value)
                setQueries([])
                setNextCursor(null)
                setOldestTimestamp(null)
              }}
              className="bg-foreground/5 border border-border rounded-md px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-foreground/20"
            >
              <option value="__all__">All Instances</option>
              {instances.map((inst) => (
                <option key={inst.id} value={inst.id}>{inst.name}</option>
              ))}
            </select>
          </div>

          {/* Domain filter */}
          <div className="flex flex-col gap-1">
            <label htmlFor="ql-domain" className="text-xs text-muted-foreground">Domain (contains, or use *)</label>
            <input
              id="ql-domain"
              type="text"
              value={domainInput}
              onChange={(e) => setDomainInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleRefresh()}
              placeholder="e.g. google"
              className="bg-foreground/5 border border-border rounded-md px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-foreground/20 w-44"
            />
          </div>

          {/* Client filter */}
          <div className="flex flex-col gap-1">
            <label htmlFor="ql-client" className="text-xs text-muted-foreground">Client IP or hostname</label>
            <input
              id="ql-client"
              type="text"
              value={clientInput}
              onChange={(e) => setClientInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleRefresh()}
              placeholder="e.g. 10.0.0.12 or 10.0.0.*"
              className="bg-foreground/5 border border-border rounded-md px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-foreground/20 w-48"
            />
          </div>

          <Button size="sm" onClick={handleRefresh} disabled={loading}>
            Refresh
          </Button>
        </div>

        {/* Status filter */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Filter:</span>
          <div className="flex gap-1">
            {STATUS_FILTERS.map((f) => (
              <button
                key={f.value}
                onClick={() => setStatusFilter(f.value)}
                aria-pressed={statusFilter === f.value}
                className={`px-3 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                  statusFilter === f.value
                    ? f.color
                    : 'bg-foreground/5 text-muted-foreground hover:bg-foreground/10'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
          {queries.length > 0 && (
            <span className="text-xs text-muted-foreground ml-2">
              {statusFilter === 'all'
                ? `${queries.length} queries loaded`
                : `${visibleQueries.length} of ${queries.length} loaded queries`}
            </span>
          )}
        </div>
      </div>

      {error && (
        <div role="alert" className="rounded-xl border border-warning/25 bg-warning/5 p-3 text-sm text-warning">
          {error}
        </div>
      )}

      {/* Table */}
      <div className="surface overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-muted-foreground text-sm animate-pulse">Loading queries...</div>
        ) : visibleQueries.length === 0 ? (
          <div className="p-8 text-center text-muted-foreground text-sm">
            {queries.length > 0 ? 'None of the loaded queries match this status' : 'No queries found'}
            {queries.length > 0 && hasMore && (
              <div className="mt-3">
                <Button size="sm" variant="outline" onClick={handleLoadMore} disabled={loadingMore}>
                  {loadingMore ? 'Loading...' : 'Load older'}
                </Button>
              </div>
            )}
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[40rem] text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left px-4 py-3 text-muted-foreground font-medium whitespace-nowrap">Time</th>
                    {isAllInstances && (
                      <th className="text-left px-4 py-3 text-muted-foreground font-medium whitespace-nowrap">Instance</th>
                    )}
                    <th className="text-left px-4 py-3 text-muted-foreground font-medium">Domain</th>
                    <th className="text-left px-4 py-3 text-muted-foreground font-medium whitespace-nowrap">Client</th>
                    <th className="text-left px-4 py-3 text-muted-foreground font-medium">Type</th>
                    <th className="text-left px-4 py-3 text-muted-foreground font-medium">Status</th>
                    <th className="text-left px-4 py-3 text-muted-foreground font-medium">Upstream</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleQueries.map((q, i) => (
                    <tr key={`${q.id}-${q.instanceId ?? ''}-${i}`} className="border-b border-border hover:bg-foreground/3 transition-colors">
                      <td className="px-4 py-2.5 text-muted-foreground font-mono text-xs whitespace-nowrap">{formatTime(q.time)}</td>
                      {isAllInstances && (
                        <td className="px-4 py-2.5">
                          <span className="inline-block px-2 py-0.5 rounded text-xs bg-foreground/8 text-foreground/60 whitespace-nowrap">
                            {q.instanceName ?? q.instanceId ?? '—'}
                          </span>
                        </td>
                      )}
                      <td className="px-4 py-2.5 text-foreground max-w-xs truncate">{q.domain}</td>
                      <td className="px-4 py-2.5 text-foreground/70 font-mono text-xs whitespace-nowrap">
                        {q.client.name || q.client.ip}
                      </td>
                      <td className="px-4 py-2.5 text-muted-foreground">{q.type}</td>
                      <td className="px-4 py-2.5">
                        <StatusBadge status={q.status} />
                      </td>
                      <td className="px-4 py-2.5 text-muted-foreground text-xs truncate max-w-[10rem]">{q.upstream ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {hasMore && (
              <div className="p-4 text-center border-t border-border">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleLoadMore}
                  disabled={loadingMore}
                >
                  {loadingMore ? 'Loading...' : 'Load older'}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

export default function QueriesPage() {
  return (
    <Suspense fallback={<div className="p-8 text-center text-muted-foreground text-sm">Loading...</div>}>
      <QueryLogContent />
    </Suspense>
  )
}
