'use client'

import { useEffect, useState, useCallback, Suspense } from 'react'
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

interface Instance {
  id: string
  name: string
}

const TIME_RANGES = [
  { label: 'Last 1h', hours: 1 },
  { label: 'Last 6h', hours: 6 },
  { label: 'Last 24h', hours: 24 },
]

function formatTime(unix: number) {
  return new Date(unix * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function QueryLogContent() {
  const searchParams = useSearchParams()
  const [instances, setInstances] = useState<Instance[]>([])
  const [selectedInstance, setSelectedInstance] = useState<string>('')
  const [hours, setHours] = useState(1)
  const [domainFilter, setDomainFilter] = useState('')
  const [clientFilter, setClientFilter] = useState(searchParams.get('client') ?? '')
  const [queries, setQueries] = useState<PiHoleQuery[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)

  useEffect(() => {
    fetch('/api/stats/summary')
      .then((r) => r.json())
      .then((data) => {
        const insts: Instance[] = (data.instances ?? []).map((i: { id: string; name: string }) => ({ id: i.id, name: i.name }))
        setInstances(insts)
        const paramInstance = searchParams.get('instance')
        if (paramInstance && insts.find((i) => i.id === paramInstance)) {
          setSelectedInstance(paramInstance)
        } else if (insts.length > 0) {
          setSelectedInstance(insts[0].id)
        }
      })
      .catch(() => {})
  }, [searchParams])

  const fetchQueries = useCallback(async (cursor?: string) => {
    if (!selectedInstance) return
    const isLoadMore = !!cursor
    isLoadMore ? setLoadingMore(true) : setLoading(true)

    const now = Math.floor(Date.now() / 1000)
    const from = now - hours * 3600
    const params = new URLSearchParams({
      from: String(from),
      until: String(now),
      length: '50',
    })
    if (cursor) params.set('cursor', cursor)
    if (domainFilter.trim()) params.set('domain', domainFilter.trim())
    if (clientFilter.trim()) params.set('client_ip', clientFilter.trim())

    try {
      const res = await fetch(`/api/pihole/${selectedInstance}/queries?${params}`)
      if (res.ok) {
        const data = await res.json()
        setQueries((prev) => isLoadMore ? [...prev, ...(data.queries ?? [])] : (data.queries ?? []))
        setNextCursor(data.nextCursor ?? null)
      }
    } catch {
      // silently ignore
    } finally {
      isLoadMore ? setLoadingMore(false) : setLoading(false)
    }
  }, [selectedInstance, hours, domainFilter, clientFilter])

  useEffect(() => {
    if (selectedInstance) fetchQueries()
  }, [selectedInstance, hours, fetchQueries])

  function handleSearch() {
    setQueries([])
    setNextCursor(null)
    fetchQueries()
  }

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
      <div className="glass-card p-4 flex flex-wrap gap-3 items-end">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-white/50">Instance</label>
          <select
            value={selectedInstance}
            onChange={(e) => { setSelectedInstance(e.target.value); setQueries([]); setNextCursor(null) }}
            className="bg-white/5 border border-white/10 rounded-md px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-white/20"
          >
            {instances.map((inst) => (
              <option key={inst.id} value={inst.id} className="bg-gray-900">{inst.name}</option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-white/50">Time range</label>
          <div className="flex gap-1">
            {TIME_RANGES.map((r) => (
              <button
                key={r.hours}
                onClick={() => { setHours(r.hours); setQueries([]); setNextCursor(null) }}
                className={`px-3 py-1.5 rounded-md text-sm transition-colors ${
                  hours === r.hours
                    ? 'bg-white/15 text-white'
                    : 'bg-white/5 text-white/50 hover:bg-white/10'
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-white/50">Domain filter</label>
          <input
            type="text"
            value={domainFilter}
            onChange={(e) => setDomainFilter(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            placeholder="e.g. ads.example.com"
            className="bg-white/5 border border-white/10 rounded-md px-3 py-1.5 text-sm text-white placeholder:text-white/20 focus:outline-none focus:ring-1 focus:ring-white/20 w-48"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-white/50">Client IP</label>
          <input
            type="text"
            value={clientFilter}
            onChange={(e) => setClientFilter(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            placeholder="e.g. 192.168.1.10"
            className="bg-white/5 border border-white/10 rounded-md px-3 py-1.5 text-sm text-white placeholder:text-white/20 focus:outline-none focus:ring-1 focus:ring-white/20 w-40"
          />
        </div>

        <Button size="sm" onClick={handleSearch} disabled={loading}>
          Search
        </Button>
      </div>

      {/* Table */}
      <div className="glass-card overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-white/30 text-sm animate-pulse">Loading queries...</div>
        ) : queries.length === 0 ? (
          <div className="p-8 text-center text-white/30 text-sm">No queries found</div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/5">
                    <th className="text-left px-4 py-3 text-white/40 font-medium">Time</th>
                    <th className="text-left px-4 py-3 text-white/40 font-medium">Domain</th>
                    <th className="text-left px-4 py-3 text-white/40 font-medium">Client</th>
                    <th className="text-left px-4 py-3 text-white/40 font-medium">Type</th>
                    <th className="text-left px-4 py-3 text-white/40 font-medium">Status</th>
                    <th className="text-left px-4 py-3 text-white/40 font-medium">Upstream</th>
                  </tr>
                </thead>
                <tbody>
                  {queries.map((q) => (
                    <tr key={q.id} className="border-b border-white/5 hover:bg-white/3 transition-colors">
                      <td className="px-4 py-2.5 text-white/50 font-mono text-xs whitespace-nowrap">{formatTime(q.time)}</td>
                      <td className="px-4 py-2.5 text-white max-w-xs truncate">{q.domain}</td>
                      <td className="px-4 py-2.5 text-white/70 font-mono text-xs whitespace-nowrap">
                        {q.client.name || q.client.ip}
                      </td>
                      <td className="px-4 py-2.5 text-white/50">{q.type}</td>
                      <td className="px-4 py-2.5">
                        <StatusBadge status={q.status} />
                      </td>
                      <td className="px-4 py-2.5 text-white/40 text-xs truncate max-w-[12rem]">{q.upstream ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {nextCursor && (
              <div className="p-4 text-center border-t border-white/5">
                <Button size="sm" variant="outline" onClick={() => fetchQueries(nextCursor)} disabled={loadingMore}>
                  {loadingMore ? 'Loading...' : 'Load more'}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const blocked = status.toLowerCase().includes('block') || status === 'GRAVITY' || status === 'BLACKLIST'
  const cached = status.toLowerCase().includes('cache')
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
      blocked ? 'bg-red-500/15 text-red-400' :
      cached  ? 'bg-blue-500/15 text-blue-400' :
                'bg-green-500/15 text-green-400'
    }`}>
      {status}
    </span>
  )
}

export default function QueriesPage() {
  return (
    <Suspense fallback={<div className="p-8 text-center text-white/30 text-sm">Loading...</div>}>
      <QueryLogContent />
    </Suspense>
  )
}
