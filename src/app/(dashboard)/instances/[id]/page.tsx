'use client'

import { useEffect, useState, useCallback } from 'react'
import { use } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import TopDomainsTable from '@/components/instance/TopDomainsTable'
import TopClientsTable from '@/components/instance/TopClientsTable'
import BlocksHistoryChart from '@/components/dashboard/BlocksHistoryChart'
import { RefreshCw, ArrowLeft, Tag, Cpu, Clock, MemoryStick } from 'lucide-react'
import Link from 'next/link'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import StatCard from '@/components/dashboard/StatCard'

interface Summary {
  queries: { total: number; blocked: number; percent_blocked: number; unique_domains: number }
  clients: { active: number; total: number }
  gravity: { domains_being_blocked: number }
}

interface InstanceData {
  id: string
  name: string
  url: string
  status: 'online' | 'offline'
  summary: Summary | null
  blocking: { blocking: 'enabled' | 'disabled' | 'unknown' } | null
}

interface TopDomain { domain: string; count: number }
interface TopClient { ip: string; name: string; count: number }

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
  const [instance, setInstance] = useState<InstanceData | null>(null)
  const [topDomains, setTopDomains] = useState<TopDomain[]>([])
  const [topClients, setTopClients] = useState<TopClient[]>([])
  const [history, setHistory] = useState<{ timestamp: number; blocked: number; total: number }[]>([])
  const [hours, setHours] = useState(24)
  const [togglingBlocking, setTogglingBlocking] = useState(false)
  const [updatingGravity, setUpdatingGravity] = useState(false)
  const [instanceInfo, setInstanceInfo] = useState<{
    version: { core: string; ftl: string; web: string }
    system: { uptime: number; memory: { ram: { used: number; total: number }; swap: { used: number; total: number } } }
  } | null>(null)

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

  async function toggleBlocking(enabled: boolean) {
    setTogglingBlocking(true)
    try {
      await fetch(`/api/pihole/${id}/blocking`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      })
      toast.success(`Blocking ${enabled ? 'enabled' : 'disabled'}`)
      fetchData()
    } catch {
      toast.error('Failed to toggle blocking')
    } finally {
      setTogglingBlocking(false)
    }
  }

  async function triggerGravity() {
    setUpdatingGravity(true)
    try {
      await fetch(`/api/pihole/${id}/gravity`, { method: 'POST' })
      toast.success('Gravity update triggered')
    } catch {
      toast.error('Failed to trigger gravity update')
    } finally {
      setUpdatingGravity(false)
    }
  }

  const isOnline = instance?.status === 'online'
  const blockingEnabled = instance?.blocking?.blocking === 'enabled'

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/">
          <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold">{instance?.name ?? 'Loading...'}</h1>
            {instance && (
              <Badge className={cn(
                isOnline
                  ? 'bg-green-500/15 text-green-400 border-green-500/25'
                  : 'bg-red-500/15 text-red-400 border-red-500/25'
              )}>
                {isOnline ? 'Online' : 'Offline'}
              </Badge>
            )}
          </div>
          {instance && <p className="text-sm text-muted-foreground">{instance.url}</p>}
        </div>
        {isOnline && (
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Blocking</span>
              <Switch
                checked={blockingEnabled}
                onCheckedChange={toggleBlocking}
                disabled={togglingBlocking}
              />
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={triggerGravity}
              disabled={updatingGravity}
              className="border-border text-foreground/70 hover:text-foreground text-xs gap-1.5"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', updatingGravity && 'animate-spin')} />
              Update Gravity
            </Button>
          </div>
        )}
      </div>

      {instance?.summary && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { label: 'Total Queries', value: instance.summary.queries.total.toLocaleString() },
            { label: 'Blocked', value: instance.summary.queries.blocked.toLocaleString() },
            { label: 'Block Rate', value: `${instance.summary.queries.percent_blocked.toFixed(1)}%` },
            { label: 'Unique Domains', value: instance.summary.queries.unique_domains.toLocaleString() },
          ].map(({ label, value }) => (
            <div key={label} className="glass-card p-4 text-center">
              <p className="text-2xl font-bold">{value}</p>
              <p className="text-xs text-muted-foreground mt-1">{label}</p>
            </div>
          ))}
        </div>
      )}

      <Tabs defaultValue="overview">
        <TabsList className="bg-white/5 border border-border">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="domains">Top Domains</TabsTrigger>
          <TabsTrigger value="clients">Top Clients</TabsTrigger>
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
          <div className="glass-card p-4">
            <TopDomainsTable domains={topDomains} />
          </div>
        </TabsContent>

        <TabsContent value="clients" className="mt-4">
          <div className="glass-card p-4">
            <TopClientsTable clients={topClients} instanceId={id} />
          </div>
        </TabsContent>

        <TabsContent value="system" className="mt-4">
          {instanceInfo ? (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <StatCard
                title="Pi-Hole"
                value={`v${instanceInfo.version.core}`}
                subtitle="Core version"
                icon={Tag}
                color="blue"
              />
              <StatCard
                title="FTL"
                value={`v${instanceInfo.version.ftl}`}
                subtitle="DNS engine version"
                icon={Cpu}
                color="purple"
              />
              <StatCard
                title="Uptime"
                value={formatUptime(instanceInfo.system.uptime)}
                subtitle="System uptime"
                icon={Clock}
                color="green"
              />
              <StatCard
                title="RAM"
                value={`${Math.round(instanceInfo.system.memory.ram.used / 1024 / 1024)} MB`}
                subtitle={`of ${Math.round(instanceInfo.system.memory.ram.total / 1024 / 1024)} MB used`}
                icon={MemoryStick}
                color="red"
              />
            </div>
          ) : (
            <div className="glass-card p-8 text-center text-muted-foreground text-sm">
              {isOnline ? 'Loading system info...' : 'Instance is offline'}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}
