'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { use } from 'react'
import { useSession } from 'next-auth/react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import StatCard from '@/components/dashboard/StatCard'
import { Activity, Database, Percent, Clock, TrendingDown, ShieldAlert, MemoryStick, RefreshCw, RotateCcw, CheckCircle2, XCircle, Wifi, Trash2, Volume2, Globe } from 'lucide-react'
import { DNS_PRESETS, PRESET_LABELS, UPSTREAM_APPLY_DISABLED, detectPreset, type DnsPreset } from '@/lib/unbound/presets'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import PageHeader from '@/components/dashboard/PageHeader'

interface UnboundStats {
  uptimeSeconds: number
  totalQueries: number
  cacheHits: number
  cacheMisses: number
  cacheHitRate: number
  avgRecursionMs: number
  servfailCount: number
  memoryCacheBytes: number
}

interface DotHealth {
  ok: boolean
  latencyMs: number | null
  upstreamMs?: number | null
  error?: string
}

function formatUptime(s: number): string {
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function fmtBytes(b: number): string {
  if (b >= 1_048_576) return `${(b / 1_048_576).toFixed(1)} MB`
  if (b >= 1024) return `${(b / 1024).toFixed(0)} KB`
  return `${b} B`
}

export default function UnboundPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const { data: session } = useSession()
  const role = session?.user?.role ?? 'viewer'

  const [instanceName, setInstanceName] = useState<string>('')
  const [unboundStatus, setUnboundStatus] = useState<'running' | 'stopped' | 'unknown'>('unknown')
  const [stats, setStats] = useState<UnboundStats | null>(null)
  const [dotHealth, setDotHealth] = useState<DotHealth | null>(null)
  const [dotCheckedAt, setDotCheckedAt] = useState<Date | null>(null)
  const [logs, setLogs] = useState<string[]>([])
  const [logN, setLogN] = useState(50)
  // fetchAll reads the line count through a ref so changing it doesn't
  // re-run the whole page load (which re-probed DoT over SSH and reset the
  // config form); the log selector refreshes only the logs.
  const logNRef = useRef(logN)
  logNRef.current = logN
  const [loading, setLoading] = useState(true)
  const [restarting, setRestarting] = useState(false)
  const [refreshingDot, setRefreshingDot] = useState(false)
  const [refreshingLogs, setRefreshingLogs] = useState(false)

  // Runtime controls
  const [selectedPreset, setSelectedPreset] = useState<DnsPreset | 'custom' | null>(null)
  const [customAddrs, setCustomAddrs] = useState('')
  const [verbosity, setVerbosity] = useState(1)
  const [flushingNode, setFlushingNode] = useState(false)
  const [flushingAll, setFlushingAll] = useState(false)
  const [applyingVerbosity, setApplyingVerbosity] = useState(false)
  const [syncingVerbosity, setSyncingVerbosity] = useState(false)

  const fetchAll = useCallback(async () => {
    const [instRes, statusRes, statsRes, dotRes, logsRes, configRes] = await Promise.allSettled([
      fetch('/api/instances'),
      fetch(`/api/unbound/${id}/status`),
      fetch(`/api/unbound/${id}/stats`),
      fetch(`/api/unbound/${id}/dot-health`),
      fetch(`/api/unbound/${id}/logs?n=${logNRef.current}`),
      fetch(`/api/unbound/${id}/config`),
    ])

    if (instRes.status === 'fulfilled' && instRes.value.ok) {
      const insts = await instRes.value.json()
      const inst = insts.find((i: { id: string; name: string }) => i.id === id)
      if (inst) setInstanceName(inst.name)
    }
    if (statusRes.status === 'fulfilled' && statusRes.value.ok) {
      const d = await statusRes.value.json()
      setUnboundStatus(d.status ?? 'unknown')
    }
    if (statsRes.status === 'fulfilled' && statsRes.value.ok) {
      setStats(await statsRes.value.json())
    }
    if (dotRes.status === 'fulfilled' && dotRes.value.ok) {
      setDotHealth(await dotRes.value.json())
      setDotCheckedAt(new Date())
    }
    if (logsRes.status === 'fulfilled' && logsRes.value.ok) {
      const d = await logsRes.value.json()
      setLogs(d.lines ?? [])
    }
    if (configRes.status === 'fulfilled' && configRes.value.ok) {
      const d = await configRes.value.json()
      const preset = detectPreset(d.forwardAddrs ?? [])
      setSelectedPreset(preset)
      if (preset === 'custom') setCustomAddrs((d.forwardAddrs ?? []).join('\n'))
    }
    setLoading(false)
  }, [id])

  useEffect(() => {
    fetchAll()
  }, [fetchAll])

  const refreshDot = async () => {
    setRefreshingDot(true)
    try {
      const res = await fetch(`/api/unbound/${id}/dot-health`)
      if (res.ok) {
        setDotHealth(await res.json())
        setDotCheckedAt(new Date())
      }
    } finally {
      setRefreshingDot(false)
    }
  }

  const refreshLogs = async (n = logN) => {
    setRefreshingLogs(true)
    try {
      const res = await fetch(`/api/unbound/${id}/logs?n=${n}`)
      if (res.ok) {
        const d = await res.json()
        setLogs(d.lines ?? [])
      }
    } finally {
      setRefreshingLogs(false)
    }
  }

  const handleLogNChange = (n: number) => {
    setLogN(n)
    refreshLogs(n)
  }

  const handleRestart = async () => {
    if (!window.confirm('Restart Unbound on this node? DNS resolution will be briefly unavailable.')) return
    setRestarting(true)
    try {
      const res = await fetch(`/api/unbound/${id}/restart`, { method: 'POST' })
      const d = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
      if (res.ok && d.success) {
        toast.success('Unbound restarted successfully')
        setTimeout(fetchAll, 3000)
      } else {
        toast.error(d.error ? `Restart failed — ${d.error}` : 'Restart failed — check server logs')
      }
    } catch {
      toast.error('Restart request failed')
    } finally {
      setRestarting(false)
    }
  }

  function bulkResultToast(results: { name: string; ok: boolean; error?: string }[], action: string) {
    const ok = results.filter((r) => r.ok).length
    const failed = results.filter((r) => !r.ok)
    if (failed.length === 0) {
      toast.success(`${action} applied to all ${ok} node${ok !== 1 ? 's' : ''}`)
    } else {
      toast.error(`${action}: ${ok}/${results.length} succeeded; failed on ${failed.map((f) => `${f.name}${f.error ? ` (${f.error})` : ''}`).join(', ')}`)
    }
  }

  const handleFlush = async (bulk: boolean) => {
    const msg = bulk ? 'Flush cache on all nodes?' : 'Flush cache on this node?'
    if (!window.confirm(msg)) return
    bulk ? setFlushingAll(true) : setFlushingNode(true)
    try {
      const url = bulk ? '/api/unbound/bulk/flush' : `/api/unbound/${id}/flush`
      const res = await fetch(url, { method: 'POST' })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(`Cache flush failed: ${d.error ?? `HTTP ${res.status}`}`)
      } else if (bulk) {
        bulkResultToast(d.results ?? [], 'Cache flush')
      } else {
        d.ok ? toast.success('Cache flushed') : toast.error(d.error ?? 'Failed')
      }
    } catch { toast.error('Request failed') }
    finally { bulk ? setFlushingAll(false) : setFlushingNode(false) }
  }

  const handleApplyVerbosity = async (bulk: boolean) => {
    bulk ? setSyncingVerbosity(true) : setApplyingVerbosity(true)
    try {
      const url = bulk ? '/api/unbound/bulk/verbosity' : `/api/unbound/${id}/verbosity`
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: verbosity }) })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(`Verbosity change failed: ${d.error ?? `HTTP ${res.status}`}`)
      } else if (bulk) {
        bulkResultToast(d.results ?? [], 'Verbosity')
      } else {
        d.ok ? toast.success(`Verbosity set to ${verbosity}`) : toast.error(d.error ?? 'Failed')
      }
    } catch { toast.error('Request failed') }
    finally { bulk ? setSyncingVerbosity(false) : setApplyingVerbosity(false) }
  }

  const statusBadge = unboundStatus === 'running'
    ? <Badge className="bg-success/15 text-success border-success/25">Running</Badge>
    : unboundStatus === 'stopped'
    ? <Badge className="bg-destructive/15 text-destructive border-destructive/25">Stopped</Badge>
    : <Badge className="bg-muted/30 text-muted-foreground border-border">Unknown</Badge>

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <PageHeader
        back={{ href: `/instances/${id}`, label: instanceName || 'Instance' }}
        title="Unbound"
        description={
          <span className="inline-flex flex-wrap items-center gap-2">
            {statusBadge}
            {stats && <span>up {formatUptime(stats.uptimeSeconds)}</span>}
          </span>
        }
      />

      {/* Stats grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <StatCard
          title="Total Queries"
          value={stats?.totalQueries.toLocaleString() ?? '—'}
          icon={Activity}
          tone="primary"
        />
        <StatCard
          title="Cache Hits"
          value={stats?.cacheHits.toLocaleString() ?? '—'}
          icon={Database}
          tone="success"
        />
        <StatCard
          title="Cache Hit Rate"
          value={stats ? `${(stats.cacheHitRate * 100).toFixed(1)}%` : '—'}
          icon={Percent}
          tone="muted"
        />
        <StatCard
          title="Avg Recursion"
          value={stats ? `${stats.avgRecursionMs.toFixed(1)} ms` : '—'}
          icon={Clock}
          tone="primary"
        />
        <StatCard
          title="Cache Misses"
          value={stats?.cacheMisses.toLocaleString() ?? '—'}
          icon={TrendingDown}
          tone="primary"
        />
        <StatCard
          title="SERVFAIL"
          value={stats?.servfailCount.toLocaleString() ?? '—'}
          subtitle={stats ? fmtBytes(stats.memoryCacheBytes) + ' cache' : undefined}
          icon={ShieldAlert}
          tone={stats && stats.servfailCount > 0 ? 'destructive' : 'primary'}
        />
      </div>
      <p className="text-xs text-muted-foreground -mt-2">
        Cumulative since last Unbound restart.
      </p>

      {/* DoT Health */}
      <div className="surface p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">DoT Health</h2>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs gap-1"
            onClick={refreshDot}
            disabled={refreshingDot}
          >
            <RefreshCw className={cn('h-3 w-3', refreshingDot && 'animate-spin')} />
            Refresh
          </Button>
        </div>
        {dotHealth ? (
          <div className="flex items-center gap-3">
            {dotHealth.ok
              ? <CheckCircle2 className="h-5 w-5 text-success shrink-0" />
              : <XCircle className="h-5 w-5 text-destructive shrink-0" />
            }
            <div>
              <p className={cn('text-sm font-medium', dotHealth.ok ? 'text-success' : 'text-destructive')}>
                {dotHealth.ok ? 'Healthy' : 'Unhealthy'}
                {dotHealth.ok && dotHealth.upstreamMs != null && ` — upstream ${dotHealth.upstreamMs} ms`}
                {dotHealth.ok && dotHealth.latencyMs != null && ` · cached ${dotHealth.latencyMs} ms`}
              </p>
              {dotHealth.error && (
                <p className="text-xs text-muted-foreground">{dotHealth.error}</p>
              )}
              {dotCheckedAt && (
                <p className="text-xs text-muted-foreground mt-0.5">
                  Checked at {dotCheckedAt.toLocaleTimeString()}
                </p>
              )}
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No health data</p>
        )}
      </div>

      {/* Runtime Controls */}
      {role === 'admin' && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold">Runtime Controls</h2>
            <span className="text-xs text-warning/80">— changes revert to config on restart</span>
          </div>

          {/* Upstream DNS */}
          <div className="surface p-5 space-y-3">
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-2">
              <Wifi className="h-3.5 w-3.5" /> Upstream DNS
            </h3>
            {/* Applying upstreams is switched off until it is rewritten to be safe —
                see UPSTREAM_APPLY_DISABLED in lib/unbound/presets.ts. The nodes set
                forward-tls-upstream per zone, and the runtime "unbound-control
                forward ." this used likely drops DoT, on both nodes at once. */}
            <p className="text-xs text-muted-foreground">
              Configured on this node:{' '}
              <span className="font-mono text-foreground">
                {selectedPreset === null
                  ? '—'
                  : selectedPreset === 'custom'
                    ? customAddrs.split('\n').filter(Boolean).join('  ·  ') || '—'
                    : `${PRESET_LABELS[selectedPreset]} (${DNS_PRESETS[selectedPreset].join('  ·  ')})`}
              </span>
            </p>
            <p className="text-xs text-warning/90">{UPSTREAM_APPLY_DISABLED}</p>
          </div>

          {/* Cache */}
          <div className="surface p-5 space-y-3">
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-2">
              <Trash2 className="h-3.5 w-3.5" /> Cache
            </h3>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => handleFlush(false)} disabled={flushingNode || flushingAll}>
                {flushingNode ? <RefreshCw className="h-3 w-3 animate-spin" /> : null}
                Flush this node
              </Button>
              <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => handleFlush(true)} disabled={flushingNode || flushingAll}>
                {flushingAll ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Globe className="h-3 w-3" />}
                Flush all nodes
              </Button>
            </div>
          </div>

          {/* Verbosity */}
          <div className="surface p-5 space-y-3">
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-2">
              <Volume2 className="h-3.5 w-3.5" /> Log Verbosity
            </h3>
            <select
              value={verbosity}
              onChange={(e) => setVerbosity(Number(e.target.value))}
              className="h-7 rounded-md border border-border bg-background px-2 text-xs"
            >
              <option value={0}>0 — Off</option>
              <option value={1}>1 — Operational</option>
              <option value={2}>2 — Detailed</option>
              <option value={3}>3 — Query-level</option>
              <option value={4}>4 — Algorithm-level</option>
              <option value={5}>5 — Debug</option>
            </select>
            <div className="flex gap-2">
              <Button size="sm" className="h-7 text-xs gap-1" onClick={() => handleApplyVerbosity(false)} disabled={applyingVerbosity || syncingVerbosity}>
                {applyingVerbosity ? <RefreshCw className="h-3 w-3 animate-spin" /> : null}
                Apply to this node
              </Button>
              <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => handleApplyVerbosity(true)} disabled={applyingVerbosity || syncingVerbosity}>
                {syncingVerbosity ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Globe className="h-3 w-3" />}
                Apply to all nodes
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Log viewer */}
      <div className="surface p-5 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold">Logs</h2>
            <select
              value={logN}
              onChange={(e) => handleLogNChange(Number(e.target.value))}
              className="h-7 rounded-md border border-border bg-background px-2 text-xs"
            >
              <option value={20}>Last 20 lines</option>
              <option value={50}>Last 50 lines</option>
              <option value={100}>Last 100 lines</option>
            </select>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs gap-1"
            onClick={() => refreshLogs()}
            disabled={refreshingLogs}
          >
            <RefreshCw className={cn('h-3 w-3', refreshingLogs && 'animate-spin')} />
            Refresh
          </Button>
        </div>
        <pre className="text-xs font-mono bg-muted/30 rounded-md p-3 overflow-x-auto max-h-80 overflow-y-auto whitespace-pre-wrap break-all">
          {logs.length > 0 ? logs.join('\n') : 'No log lines available'}
        </pre>
      </div>

      {/* Restart — admin only */}
      {role === 'admin' && (
        <div className="flex justify-end">
          <Button
            variant="destructive"
            size="sm"
            className="gap-2"
            onClick={handleRestart}
            disabled={restarting}
          >
            <RotateCcw className={cn('h-4 w-4', restarting && 'animate-spin')} />
            {restarting ? 'Restarting…' : 'Restart Unbound'}
          </Button>
        </div>
      )}
    </div>
  )
}
