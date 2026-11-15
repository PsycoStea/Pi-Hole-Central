'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { RefreshCw, CheckCircle2, AlertTriangle, Container, Crown } from 'lucide-react'
import PageHeader from '@/components/dashboard/PageHeader'

interface InstanceMetrics {
  id: string
  name: string
  online: boolean
  metrics: Record<string, number> | null
  error?: string
}
interface MetricComparison {
  key: string
  label: string
  values: Record<string, number>
  inSync: boolean
}
interface NebulaHostStatus {
  configured: boolean
  reachable: boolean
  container: { name: string; status: string; health: string; startedAt: string } | null
  recentLogs: string[]
  error?: string
}
interface SyncStatus {
  checkedAt: string
  comparable: boolean
  inSync: boolean
  instances: InstanceMetrics[]
  metrics: MetricComparison[]
  host?: NebulaHostStatus
}

function uptime(startedAt: string): string {
  const t = new Date(startedAt).getTime()
  if (!t) return ''
  const s = Math.floor((Date.now() - t) / 1000)
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600)
  return d > 0 ? `${d}d ${h}h` : `${h}h ${Math.floor((s % 3600) / 60)}m`
}

export default function SyncStatusPage() {
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [cfg, setCfg] = useState({ host: '', user: 'root', container: 'nebula-sync' })
  const [savingCfg, setSavingCfg] = useState(false)
  const [allInstances, setAllInstances] = useState<{ id: string; name: string; url: string }[]>([])
  const [primaryId, setPrimaryId] = useState('')
  const [savedPrimaryId, setSavedPrimaryId] = useState('')
  const [savingPrimary, setSavingPrimary] = useState(false)

  useEffect(() => {
    fetch('/api/settings').then((r) => (r.ok ? r.json() : null)).then((s) => {
      if (s) {
        setCfg({ host: s.nebulaHost ?? '', user: s.nebulaSshUser ?? 'root', container: s.nebulaContainer ?? 'nebula-sync' })
        setPrimaryId(s.primaryInstanceId ?? '')
        setSavedPrimaryId(s.primaryInstanceId ?? '')
      }
    }).catch(() => {})
    fetch('/api/instances').then((r) => (r.ok ? r.json() : [])).then((rows) => {
      setAllInstances((rows ?? []).map((i: { id: string; name: string; url: string }) => ({ id: i.id, name: i.name, url: i.url })))
    }).catch(() => {})
  }, [])

  const savePrimary = async () => {
    setSavingPrimary(true)
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ primaryInstanceId: primaryId || null }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Save failed')
      setSavedPrimaryId(primaryId)
      toast.success(primaryId ? 'Primary node saved; the other nodes are now read-only in the editors' : 'Primary node cleared')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSavingPrimary(false)
    }
  }

  const fetchStatus = useCallback(async (refresh = false) => {
    setLoading(true)
    try {
      const r = await fetch(`/api/nebula/status${refresh ? '?refresh=1' : ''}`)
      if (r.ok) setStatus(await r.json())
    } catch {
      /* ignore */
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchStatus() }, [fetchStatus])

  const saveConfig = async () => {
    setSavingCfg(true)
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nebulaHost: cfg.host, nebulaSshUser: cfg.user, nebulaContainer: cfg.container }),
      })
      if (!res.ok) throw new Error((await res.json()).error ?? 'Save failed')
      toast.success('Nebula-sync host saved')
      fetchStatus(true)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSavingCfg(false)
    }
  }

  const online = status?.instances.filter((i) => i.online) ?? []

  return (
    <div className="space-y-6 max-w-3xl">
      <PageHeader
        title="Sync Status"
        description="Config consistency across your Pi-hole nodes (nebula-sync)."
        actions={
          <>
            <Button variant="outline" onClick={() => fetchStatus(true)} disabled={loading} className="gap-1.5">
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} /> Refresh
        </Button>
          </>
        }
      />

      {/* Primary node: the one nebula-sync copies FROM. Editors write here only. */}
      <div className="surface p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Crown className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-medium">Primary node</h2>
        </div>
        <p className="text-xs text-muted-foreground">
          The node nebula-sync copies config <em>from</em>. Domains, adlists and clients are edited here only; the
          other nodes are shown read-only, because nebula-sync overwrites them at every sync. Must match the
          primary in your nebula-sync config.
        </p>
        <div className="flex items-end gap-2 flex-wrap">
          <select value={primaryId} onChange={(e) => setPrimaryId(e.target.value)}
            aria-label="Primary node"
            className="h-9 rounded-lg bg-background border border-border text-foreground text-sm px-3 min-w-[14rem]">
            <option value="">Not set (all nodes editable)</option>
            {allInstances.map((i) => <option key={i.id} value={i.id}>{i.name} ({i.url.replace(/^https?:\/\//, '')})</option>)}
          </select>
          <Button size="sm" onClick={savePrimary} disabled={savingPrimary || primaryId === savedPrimaryId}
           >Save</Button>
        </div>
        {!savedPrimaryId && (
          <p className="text-xs text-warning">No primary set: edits made on a replica are undone at the next sync.</p>
        )}
      </div>

      {/* Overall status */}
      {status && (
        <div className={cn(
          'surface p-4 flex items-center gap-3 border',
          !status.comparable ? 'border-border'
            : status.inSync ? 'border-success/25 bg-success/5' : 'border-warning/25 bg-warning/5'
        )}>
          {!status.comparable ? (
            <span className="text-sm text-muted-foreground">
              Need at least two online nodes to compare ({online.length} online).
            </span>
          ) : status.inSync ? (
            <>
              <CheckCircle2 className="h-5 w-5 text-success" />
              <span className="text-sm font-medium text-success">In sync</span>
              <span className="text-xs text-muted-foreground">All compared config counts match across nodes.</span>
            </>
          ) : (
            <>
              <AlertTriangle className="h-5 w-5 text-warning" />
              <span className="text-sm font-medium text-warning">Drift detected</span>
              <span className="text-xs text-muted-foreground">Some config counts differ — nebula-sync may be failing or mid-cycle.</span>
            </>
          )}
        </div>
      )}

      {/* Comparison table */}
      {status && online.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[28rem] text-sm">
            <thead>
              <tr className="text-muted-foreground text-left border-b border-border">
                <th className="py-2 font-medium">Metric</th>
                {online.map((i) => <th key={i.id} className="py-2 font-medium text-right">{i.name}</th>)}
                <th className="py-2 font-medium text-right w-16"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {status.metrics.map((m) => (
                <tr key={m.key} className={cn(!m.inSync && 'bg-warning/5')}>
                  <td className="py-2">{m.label}</td>
                  {online.map((i) => (
                    <td key={i.id} className={cn('py-2 text-right tabular-nums', !m.inSync && 'text-warning font-medium')}>
                      {m.values[i.id] ?? '—'}
                    </td>
                  ))}
                  <td className="py-2 text-right">
                    {m.inSync
                      ? <CheckCircle2 className="h-4 w-4 text-success inline" />
                      : <AlertTriangle className="h-4 w-4 text-warning inline" />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Offline notes */}
      {status?.instances.filter((i) => !i.online).map((i) => (
        <p key={i.id} className="text-xs text-destructive/80">{i.name}: unreachable ({i.error})</p>
      ))}

      {status && (
        <p className="text-xs text-muted-foreground">
          Checked {new Date(status.checkedAt).toLocaleString()} · compares gravity, adlists, groups, allow/deny domains and clients.
        </p>
      )}

      {/* nebula-sync host / container status */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Container className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-medium">nebula-sync container</h2>
        </div>

        {!status?.host?.configured ? (
          <div className="surface p-4 space-y-3">
            <p className="text-xs text-muted-foreground">
              Point this at the host running the nebula-sync container to show its live status (needs SSH access from
              pihole-central to that host).
            </p>
            <div className="flex items-end gap-2 flex-wrap">
              <div>
                <Label className="text-xs text-muted-foreground">Host</Label>
                <Input value={cfg.host} onChange={(e) => setCfg({ ...cfg, host: e.target.value })}
                  placeholder="192.168.1.10" className="bg-foreground/5 border-border w-40" />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">SSH user</Label>
                <Input value={cfg.user} onChange={(e) => setCfg({ ...cfg, user: e.target.value })}
                  className="bg-foreground/5 border-border w-28" />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Container</Label>
                <Input value={cfg.container} onChange={(e) => setCfg({ ...cfg, container: e.target.value })}
                  className="bg-foreground/5 border-border w-36" />
              </div>
              <Button size="sm" onClick={saveConfig} disabled={savingCfg}>Save</Button>
            </div>
          </div>
        ) : !status.host.reachable || !status.host.container ? (
          <div className="rounded-xl border border-destructive/20 bg-destructive/5 p-4">
            <p className="text-sm text-destructive">Can't read the container on {cfg.host}</p>
            <p className="text-xs text-muted-foreground mt-1">{status.host.error ?? 'unreachable'}</p>
            <p className="text-xs text-muted-foreground mt-1">
              Ensure pihole-central's SSH key is authorized on {cfg.host} and Docker is reachable as {cfg.user}.
            </p>
          </div>
        ) : (
          <div className="surface p-4 space-y-3">
            <div className="flex items-center gap-3">
              <span className={cn('h-2.5 w-2.5 rounded-full',
                status.host.container.status === 'running'
                  ? (status.host.container.health === 'unhealthy' ? 'bg-warning' : 'bg-success')
                  : 'bg-destructive')} />
              <span className="text-sm font-medium capitalize">{status.host.container.status}</span>
              {status.host.container.health && (
                <span className="text-xs text-muted-foreground">({status.host.container.health})</span>
              )}
              {status.host.container.startedAt && (
                <span className="text-xs text-muted-foreground ml-auto">up {uptime(status.host.container.startedAt)}</span>
              )}
            </div>
            {status.host.recentLogs.length > 0 && (
              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Recent logs</summary>
                <pre className="mt-2 max-h-56 overflow-auto rounded-lg bg-foreground/5 p-2 text-[11px] leading-relaxed whitespace-pre-wrap">
                  {status.host.recentLogs.join('\n')}
                </pre>
              </details>
            )}
          </div>
        )}
      </div>

      <div className="surface p-4 text-xs text-muted-foreground border border-border">
        Drift compares the resulting config on each node (nebula-sync has no API to query directly); the container
        panel reads live status over SSH from the nebula-sync host.
      </div>
    </div>
  )
}
