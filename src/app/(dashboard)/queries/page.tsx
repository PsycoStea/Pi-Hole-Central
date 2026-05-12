'use client'

import { useEffect, useState, useCallback, useRef, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { ScrollText } from 'lucide-react'

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
  { label: 'All', value: 'all', color: 'bg-white/15 text-white' },
  { label: 'Blocked', value: 'blocked', color: 'bg-red-500/20 text-red-400' },
  { label: 'Cached', value: 'cached', color: 'bg-blue-500/20 text-blue-400' },
  { label: 'Forwarded', value: 'forwarded', color: 'bg-green-500/20 text-green-400' },
]

function formatTime(unix: number) {
  return new Date(unix * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function classifyStatus(status: string): 'blocked' | 'cached' | 'forwarded' {
  const s = status.toLowerCase()
  if (s.includes('block') || s === 'gravity' || s === 'blacklist') return 'blocked'
  if (s.includes('cache')) return 'cached'
  return 'forwarded'
}

function StatusBadge({ status }: { status: string }) {
  const cat = classifyStatus(status)
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
      cat === 'blocked' ? 'bg-red-500/15 text-red-400' :
      cat === 'cached'  ? 'bg-blue-500/15 text-blue-400' :
                          'bg-green-500/15 text-green-400'
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

  const [statusFilter, setStatusFilter] = useState<StatusCategory>('all')
  const [queries, setQueries] = useState<QueryRow[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [oldestTimestamp, setOldestTimestamp] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)

  const fetchIdRef = useRef(0)
  const isAllInstances = selectedInstance === '__all__'

  useEffect(() => {
    fetch('/api/stats/summary')
      .then((r) => r.json())
      .then((data) => {
        const insts: Instance[] = (data.instances ?? []).map((i: { id: string; name: string }) => ({
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

      const url = isAllInstances
        ? `/api/pihole/queries?${params}`
        : `/api/pihole/${selectedInstance}/queries?${params}`

      try {
        const res = await fetch(url)
        if (!res.ok) return
        if (fetchId !== fetchIdRef.current) return

        const data = await res.json()

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
        // silently ignore network errors
      } finally {
        if (fetchId === fetchIdRef.current) {
          isLoadMore ? setLoadingMore(false) : setLoading(false)
        }
      }
    },
    [selectedInstance, isAllInstances]
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
    setStatusFilter('all')
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

  // Client-side filtering: domain = substring, client IP = exact, client name = substring
  const visibleQueries = queries.filter((q) => {
    if (domainInput && !q.domain.toLowerCase().includes(domainInput.toLowerCase())) return false
    if (clientInput) {
      const ipMatch = q.client.ip === clientInput
      const nameMatch = q.client.name.toLowerCase().includes(clientInput.toLowerCase())
      if (!ipMatch && !nameMatch) return false
    }
    if (statusFilter !== 'all' && classifyStatus(q.status) !== statusFilter) return false
    return true
  })

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <ScrollText className="h-6 w-6 text-white/50" />
        <div>
          <h1 className="text-2xl font-bold">Query Log</h1>
          <p className="text-sm text-white/40 mt-0.5">DNS queries from your Pi-Hole instances</p>
        </div>
      </div>

      {/* Filters */}
      <div className="glass-card p-4 space-y-3">
        <div className="flex flex-wrap gap-3 items-end">
          {/* Instance selector */}
          <div className="flex flex-col gap-1">
            <label className="text-xs text-white/50">Instance</label>
            <select
              value={selectedInstance}
              onChange={(e) => {
                setSelectedInstance(e.target.value)
                setQueries([])
                setNextCursor(null)
                setOldestTimestamp(null)
              }}
              className="bg-white/5 border border-white/10 rounded-md px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-white/20"
            >
              <option value="__all__" className="bg-gray-900">All Instances</option>
              {instances.map((inst) => (
                <option key={inst.id} value={inst.id} className="bg-gray-900">{inst.name}</option>
              ))}
            </select>
          </div>

          {/* Domain filter */}
          <div className="flex flex-col gap-1">
            <label className="text-xs text-white/50">Domain (substring)</label>
            <input
              type="text"
              value={domainInput}
              onChange={(e) => setDomainInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleRefresh()}
              placeholder="e.g. google"
              className="bg-white/5 border border-white/10 rounded-md px-3 py-1.5 text-sm text-white placeholder:text-white/20 focus:outline-none focus:ring-1 focus:ring-white/20 w-44"
            />
          </div>

          {/* Client filter */}
          <div className="flex flex-col gap-1">
            <label className="text-xs text-white/50">Client IP (exact) / hostname</label>
            <input
              type="text"
              value={clientInput}
              onChange={(e) => setClientInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleRefresh()}
              placeholder="e.g. 192.168.1.10"
              className="bg-white/5 border border-white/10 rounded-md px-3 py-1.5 text-sm text-white placeholder:text-white/20 focus:outline-none focus:ring-1 focus:ring-white/20 w-48"
            />
          </div>

          <Button size="sm" onClick={handleRefresh} disabled={loading}>
            Refresh
          </Button>
        </div>

        {/* Status filter */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-white/40">Filter:</span>
          <div className="flex gap-1">
            {STATUS_FILTERS.map((f) => (
              <button
                key={f.value}
                onClick={() => setStatusFilter(f.value)}
                className={`px-3 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                  statusFilter === f.value
                    ? f.color
                    : 'bg-white/5 text-white/40 hover:bg-white/10'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
          {queries.length > 0 && (
            <span className="text-xs text-white/30 ml-2">
              {visibleQueries.length} of {queries.length} queries
            </span>
          )}
        </div>
      </div>

      {/* Table */}
      <div className="glass-card overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-white/30 text-sm animate-pulse">Loading queries...</div>
        ) : visibleQueries.length === 0 ? (
          <div className="p-8 text-center text-white/30 text-sm">
            {queries.length > 0 ? 'No queries match the selected filter' : 'No queries found'}
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/5">
                    <th className="text-left px-4 py-3 text-white/40 font-medium whitespace-nowrap">Time</th>
                    {isAllInstances && (
                      <th className="text-left px-4 py-3 text-white/40 font-medium whitespace-nowrap">Instance</th>
                    )}
                    <th className="text-left px-4 py-3 text-white/40 font-medium">Domain</th>
                    <th className="text-left px-4 py-3 text-white/40 font-medium whitespace-nowrap">Client</th>
                    <th className="text-left px-4 py-3 text-white/40 font-medium">Type</th>
                    <th className="text-left px-4 py-3 text-white/40 font-medium">Status</th>
                    <th className="text-left px-4 py-3 text-white/40 font-medium">Upstream</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleQueries.map((q, i) => (
                    <tr key={`${q.id}-${q.instanceId ?? ''}-${i}`} className="border-b border-white/5 hover:bg-white/3 transition-colors">
                      <td className="px-4 py-2.5 text-white/50 font-mono text-xs whitespace-nowrap">{formatTime(q.time)}</td>
                      {isAllInstances && (
                        <td className="px-4 py-2.5">
                          <span className="inline-block px-2 py-0.5 rounded text-xs bg-white/8 text-white/60 whitespace-nowrap">
                            {q.instanceName ?? q.instanceId ?? '—'}
                          </span>
                        </td>
                      )}
                      <td className="px-4 py-2.5 text-white max-w-xs truncate">{q.domain}</td>
                      <td className="px-4 py-2.5 text-white/70 font-mono text-xs whitespace-nowrap">
                        {q.client.name || q.client.ip}
                      </td>
                      <td className="px-4 py-2.5 text-white/50">{q.type}</td>
                      <td className="px-4 py-2.5">
                        <StatusBadge status={q.status} />
                      </td>
                      <td className="px-4 py-2.5 text-white/40 text-xs truncate max-w-[10rem]">{q.upstream ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {hasMore && (
              <div className="p-4 text-center border-t border-white/5">
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
    <Suspense fallback={<div className="p-8 text-center text-white/30 text-sm">Loading...</div>}>
      <QueryLogContent />
    </Suspense>
  )
}
