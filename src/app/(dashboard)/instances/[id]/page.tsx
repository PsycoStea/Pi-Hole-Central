'use client'

import { useEffect, useState, useCallback } from 'react'
import { use } from 'react'
import { useSession } from 'next-auth/react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

import { Button, buttonVariants } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import TopDomainsTable from '@/components/instance/TopDomainsTable'
import TopClientsTable from '@/components/instance/TopClientsTable'
import BlocksHistoryChart from '@/components/dashboard/BlocksHistoryChart'
import { RefreshCw, Tag, Cpu, Clock, MemoryStick, Loader2 } from 'lucide-react'
import Link from 'next/link'
import { toast } from 'sonner'
import { api, errorText } from '@/lib/client/api'
import { cn } from '@/lib/utils'
import StatCard from '@/components/dashboard/StatCard'
import PageHeader from '@/components/dashboard/PageHeader'
import { StatusPill } from '@/components/dashboard/InstanceCard'
import { Activity, Globe, Shield, ShieldOff } from 'lucide-react'

interface Summary {
  queries: { total: number; blocked: number; percent_blocked: number; unique_domains: number }
  clients: { active: number; total: number }
  gravity: { domains_being_blocked: number }
}

interface InstanceData {
  id: string
  name: string
  url: string
  sshUsername?: string | null
  status: 'online' | 'offline'
  summary: Summary | null
  blocking: { blocking: 'enabled' | 'disabled' | 'unknown' } | null
}

interface TopDomain { domain: string; count: number }
interface TopClient { ip: string; name: string; count: number }

interface RecoveryEvent {
  id: number
  timestamp: string
  eventType: string
  detail: string
  success: boolean
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

export default function InstanceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = use(params)
  const { data: session } = useSession()
  const isAdmin = session?.user?.role === 'admin'
  const [instance, setInstance] = useState<InstanceData | null>(null)
  const [topDomains, setTopDomains] = useState<TopDomain[]>([])
  const [topClients, setTopClients] = useState<TopClient[]>([])
  const [history, setHistory] = useState<{ timestamp: number; blocked: number; total: number }[]>([])
  const [hours, setHours] = useState(24)
  const [recoveryEvents, setRecoveryEvents] = useState<RecoveryEvent[]>([])
  const [togglingBlocking, setTogglingBlocking] = useState(false)
  const [updatingGravity, setUpdatingGravity] = useState(false)
  const [unboundStatus, setUnboundStatus] = useState<'running' | 'stopped' | 'unknown'>('unknown')
  const [instanceInfo, setInstanceInfo] = useState<{
    version: {
      core: { local: string; remote: string }
      ftl:  { local: string; remote: string }
      web:  { local: string; remote: string }
    }
    system: { uptime: number; memory: { ram: { used: number; total: number }; swap: { used: number; total: number } } }
  } | null>(null)
  const [updatingPihole, setUpdatingPihole] = useState(false)
  // Set once the summary has loaded without this id: the instance is disabled
  // or was deleted (the summary only lists enabled instances).
  const [missing, setMissing] = useState(false)

  const fetchData = useCallback(async () => {
    const [summaryRes, historyRes, topRes] = await Promise.allSettled([
      fetch('/api/stats/summary'),
      fetch(`/api/pihole/${id}/history?hours=${hours}`),
      fetch(`/api/pihole/${id}/top`),
    ])

    if (summaryRes.status === 'fulfilled' && summaryRes.value.ok) {
      const data = await summaryRes.value.json()
      const inst = data.instances?.find((i: InstanceData) => i.id === id)
      if (inst) setInstance(inst)
      setMissing(!inst)
    }
    if (historyRes.status === 'fulfilled' && historyRes.value.ok) {
      const { data } = await historyRes.value.json()
      setHistory(data ?? [])
    }
    if (topRes.status === 'fulfilled' && topRes.value.ok) {
      const { topDomains, topClients } = await topRes.value.json()
      setTopDomains(topDomains ?? [])
      setTopClients(topClients ?? [])
    }
  }, [id, hours])

  useEffect(() => { fetchData() }, [fetchData])

  useEffect(() => {
    fetch(`/api/pihole/${id}/info`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => { if (data) setInstanceInfo(data) })
      .catch(() => {})
  }, [id])

  useEffect(() => {
    fetch(`/api/instances/${id}/recovery-events`)
      .then((r) => r.ok ? r.json() : { events: [] })
      .then(({ events }) => setRecoveryEvents(events ?? []))
      .catch(() => {})
  }, [id])

  // Unbound status (for the header link dot) — only meaningful on SSH-enabled nodes
  useEffect(() => {
    if (!instance?.sshUsername || !isAdmin) return
    fetch(`/api/unbound/${id}/status`)
      .then((r) => (r.ok ? r.json() : {}))
      .then((d: { status?: 'running' | 'stopped' | 'unknown' }) => setUnboundStatus(d.status ?? 'unknown'))
      .catch(() => {})
  }, [id, instance?.sshUsername, isAdmin])

  async function toggleBlocking(enabled: boolean) {
    setTogglingBlocking(true)
    try {
      await api(`/api/pihole/${id}/blocking`, { method: 'POST', json: { enabled } })
      toast.success(`Blocking ${enabled ? 'enabled' : 'disabled'}`)
      fetchData()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to toggle blocking')
    } finally {
      setTogglingBlocking(false)
    }
  }

  async function updatePihole() {
    if (!window.confirm(`Run "pihole -up" on ${instance?.name ?? 'this node'}? DNS on this node may drop for a few minutes while it updates.`)) return
    setUpdatingPihole(true)
    try {
      await api(`/api/pihole/${id}/update`, { method: 'POST' })
      toast.success('Update started — this may take a few minutes')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to start update')
    } finally {
      setUpdatingPihole(false)
    }
  }

  async function triggerGravity() {
    setUpdatingGravity(true)
    const t = toast.loading('Updating gravity…')
    try {
      const data = await api<{ failedLists?: number; message?: string }>(`/api/pihole/${id}/gravity`, { method: 'POST' })
      if (data.failedLists) toast.warning(data.message ?? 'Gravity updated with list failures', { id: t })
      else toast.success(data.message ?? 'Gravity updated', { id: t })
    } catch (err) {
      toast.error(`Gravity failed: ${errorText(err)}`, { id: t })
    } finally {
      setUpdatingGravity(false)
    }
  }

  const isOnline = instance?.status === 'online'
  const blockingEnabled = instance?.blocking?.blocking === 'enabled'

  if (missing && !instance) {
    return (
      <div className="surface p-12 text-center space-y-3 max-w-lg mx-auto mt-8">
        <p className="font-medium">This instance is disabled or no longer exists.</p>
        <p className="text-sm text-muted-foreground">
          Disabled instances aren&apos;t polled, so there is nothing to show.
          {isAdmin && ' Re-enable it under Settings → Instances.'}
        </p>
        <div className="flex justify-center gap-3 text-sm">
          <Link href="/" className="text-primary hover:underline">Back to overview</Link>
          {isAdmin && <Link href="/settings/instances" className="text-primary hover:underline">Settings → Instances</Link>}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <PageHeader
        back={{ href: '/', label: 'Overview' }}
        title={
          <span className="inline-flex max-w-full items-center gap-3">
            <span className="truncate">{instance?.name ?? 'Loading…'}</span>
            {instance && <StatusPill online={isOnline} />}
          </span>
        }
        description={instance && <span className="font-mono text-xs">{instance.url.replace(/^https?:\/\//, '')}</span>}
        actions={
          <>
            {instance?.sshUsername && isAdmin && (
              <Link
                href={`/instances/${id}/unbound`}
                title="Unbound management"
                className={buttonVariants({ variant: 'outline' })}
              >
                <span
                  aria-hidden
                  className={cn(
                    'h-1.5 w-1.5 rounded-full',
                    unboundStatus === 'running'
                      ? 'bg-success'
                      : unboundStatus === 'stopped'
                      ? 'bg-destructive'
                      : 'bg-muted-foreground/40'
                  )}
                />
                Unbound
              </Link>
            )}
            {isOnline && isAdmin && (
              <>
                <label className="flex h-8 items-center gap-2 rounded-lg border border-border px-2.5 text-sm text-muted-foreground">
                  Blocking
                  <Switch
                    checked={blockingEnabled}
                    onCheckedChange={toggleBlocking}
                    disabled={togglingBlocking}
                    aria-label={`Ad blocking on ${instance?.name ?? 'this node'}`}
                  />
                </label>
                <Button onClick={triggerGravity} disabled={updatingGravity}>
                  <RefreshCw className={cn(updatingGravity && 'animate-spin')} />
                  Update Gravity
                </Button>
              </>
            )}
            {isOnline && !isAdmin && (
              <span className="text-sm text-muted-foreground">
                Blocking {blockingEnabled ? 'enabled' : 'disabled'}
              </span>
            )}
          </>
        }
      />

      {instance?.summary && (
        <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
          <StatCard title="Total queries" value={instance.summary.queries.total.toLocaleString()} icon={Activity} tone="primary" />
          <StatCard title="Blocked" value={instance.summary.queries.blocked.toLocaleString()} icon={ShieldOff} tone="destructive" />
          <StatCard title="Block rate" value={`${instance.summary.queries.percent_blocked.toFixed(1)}%`} icon={Shield} tone="success" />
          <StatCard title="Unique domains" value={instance.summary.queries.unique_domains.toLocaleString()} icon={Globe} />
        </div>
      )}

      <Tabs defaultValue="overview">
        <TabsList className="max-w-full justify-start overflow-x-auto">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="domains">Top Domains</TabsTrigger>
          <TabsTrigger value="clients">Top Clients</TabsTrigger>
          <TabsTrigger value="recovery">Recovery</TabsTrigger>
          <TabsTrigger value="system">System</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-4">
          <div className="flex items-center gap-3 mb-4">
            {[24, 168, 720].map((h) => (
              <Button
                key={h}
                variant={hours === h ? 'default' : 'ghost'}
                size="sm"
                onClick={() => setHours(h)}
                className="text-xs"
              >
                {h === 24 ? '24h' : h === 168 ? '7d' : '30d'}
              </Button>
            ))}
          </div>
          <BlocksHistoryChart
            data={history}
            label={
              hours === 24
                ? 'Blocked queries — last 24 hours (10-min intervals)'
                : hours === 168
                ? 'Blocked queries — last 7 days (1-hour intervals)'
                : 'Blocked queries — last 30 days (6-hour intervals)'
            }
          />
        </TabsContent>

        <TabsContent value="domains" className="mt-4">
          <div className="surface p-4">
            <TopDomainsTable domains={topDomains} />
          </div>
        </TabsContent>

        <TabsContent value="clients" className="mt-4">
          <div className="surface p-4">
            <TopClientsTable clients={topClients} instanceId={id} />
          </div>
        </TabsContent>

        <TabsContent value="recovery" className="mt-4">
          <div className="surface p-4">
            {recoveryEvents.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-6">
                No recovery events recorded.
              </p>
            ) : (
              <div className="space-y-2">
                {recoveryEvents.map((ev) => (
                  <div
                    key={ev.id}
                    className={cn(
                      'flex items-start gap-3 p-3 rounded-lg border text-sm',
                      ev.success
                        ? 'border-success/20 bg-success/5'
                        : 'border-destructive/20 bg-destructive/5'
                    )}
                  >
                    <div
                      className={cn(
                        'mt-1 h-2 w-2 rounded-full shrink-0',
                        ev.success ? 'bg-success' : 'bg-destructive'
                      )}
                    />
                    <div className="flex-1 min-w-0">
                      <p className="font-medium capitalize">
                        {ev.eventType.replace(/_/g, ' ')}
                      </p>
                      {ev.detail && (
                        <p className="text-xs text-muted-foreground mt-0.5">{ev.detail}</p>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground shrink-0 mt-0.5">
                      {new Date(ev.timestamp).toLocaleString()}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </TabsContent>

        <TabsContent value="system" className="mt-4">
          {instanceInfo ? (() => {
            const updateAvailable =
              instanceInfo.version.core.local !== instanceInfo.version.core.remote ||
              instanceInfo.version.ftl.local  !== instanceInfo.version.ftl.remote  ||
              instanceInfo.version.web.local  !== instanceInfo.version.web.remote
            return (
              <div className="space-y-4">
                {updateAvailable && (
                  <div className="flex items-center justify-between surface p-4">
                    <p className="text-sm text-warning">A Pi-Hole update is available</p>
                    {isAdmin && (
                      <Button
                        size="sm"
                        onClick={updatePihole}
                        disabled={updatingPihole}
                        className="bg-warning hover:bg-warning gap-1.5"
                      >
                        {updatingPihole && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                        Update Pi-Hole
                      </Button>
                    )}
                  </div>
                )}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <StatCard
                    title="Pi-Hole"
                    value={instanceInfo.version.core.local}
                    subtitle="Core version"
                    badge={instanceInfo.version.core.local !== instanceInfo.version.core.remote ? `Update: ${instanceInfo.version.core.remote}` : undefined}
                    icon={Tag}
                    tone="primary"
                  />
                  <StatCard
                    title="FTL"
                    value={instanceInfo.version.ftl.local}
                    subtitle="DNS engine version"
                    badge={instanceInfo.version.ftl.local !== instanceInfo.version.ftl.remote ? `Update: ${instanceInfo.version.ftl.remote}` : undefined}
                    icon={Cpu}
                    tone="muted"
                  />
                  <StatCard
                    title="Uptime"
                    value={formatUptime(instanceInfo.system.uptime)}
                    subtitle="System uptime"
                    icon={Clock}
                    tone="success"
                  />
                  <StatCard
                    title="RAM"
                    value={`${Math.round(instanceInfo.system.memory.ram.used / 1024)} MB`}
                    subtitle={`of ${Math.round(instanceInfo.system.memory.ram.total / 1024)} MB total`}
                    icon={MemoryStick}
                    tone="destructive"
                  />
                </div>
              </div>
            )
          })() : (
            <div className="surface p-8 text-center text-muted-foreground text-sm">
              {isOnline ? 'Loading system info...' : 'Instance is offline'}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}
