'use client'

import { useEffect, useState, useCallback } from 'react'
import { use } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import TopDomainsTable from '@/components/instance/TopDomainsTable'
import TopClientsTable from '@/components/instance/TopClientsTable'
import BlockRateChart from '@/components/dashboard/BlockRateChart'
import { RefreshCw, ArrowLeft } from 'lucide-react'
import Link from 'next/link'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

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
  blocking: { blocking: boolean } | null
}

interface TopDomain { domain: string; count: number }
interface TopClient { ip: string; name: string; count: number }

export default function InstanceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = use(params)
  const [instance, setInstance] = useState<InstanceData | null>(null)
  const [topDomains, setTopDomains] = useState<TopDomain[]>([])
  const [topClients, setTopClients] = useState<TopClient[]>([])
  const [history, setHistory] = useState<unknown[]>([])
  const [hours, setHours] = useState(24)
  const [togglingBlocking, setTogglingBlocking] = useState(false)
  const [updatingGravity, setUpdatingGravity] = useState(false)

  const fetchData = useCallback(async () => {
    const [summaryRes, historyRes, topRes] = await Promise.allSettled([
      fetch('/api/stats/summary'),
      fetch(`/api/stats/history?instanceId=${id}&hours=${hours}`),
      fetch(`/api/pihole/${id}/top`),
    ])

    if (summaryRes.status === 'fulfilled' && summaryRes.value.ok) {
      const data = await summaryRes.value.json()
      const inst = data.instances?.find((i: InstanceData) => i.id === id)
      if (inst) setInstance(inst)
    }
    if (historyRes.status === 'fulfilled' && historyRes.value.ok) {
      setHistory(await historyRes.value.json())
    }
    if (topRes.status === 'fulfilled' && topRes.value.ok) {
      const { topDomains, topClients } = await topRes.value.json()
      setTopDomains(topDomains ?? [])
      setTopClients(topClients ?? [])
    }
  }, [id, hours])

  useEffect(() => { fetchData() }, [fetchData])

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
  const blockingEnabled = instance?.blocking?.blocking === true

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/">
          <Button variant="ghost" size="icon" className="h-8 w-8 text-white/50 hover:text-white">
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
          {instance && <p className="text-sm text-white/40">{instance.url}</p>}
        </div>
        {isOnline && (
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <span className="text-xs text-white/50">Blocking</span>
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
              className="border-white/10 text-white/70 hover:text-white text-xs gap-1.5"
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
              <p className="text-xs text-white/40 mt-1">{label}</p>
            </div>
          ))}
        </div>
      )}

      <Tabs defaultValue="overview">
        <TabsList className="bg-white/5 border border-white/10">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="domains">Top Domains</TabsTrigger>
          <TabsTrigger value="clients">Top Clients</TabsTrigger>
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
          <BlockRateChart
            data={history as never[]}
            instanceNames={instance ? { [instance.id]: instance.name } : {}}
          />
        </TabsContent>

        <TabsContent value="domains" className="mt-4">
          <div className="glass-card p-4">
            <TopDomainsTable domains={topDomains} />
          </div>
        </TabsContent>

        <TabsContent value="clients" className="mt-4">
          <div className="glass-card p-4">
            <TopClientsTable clients={topClients} />
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}
