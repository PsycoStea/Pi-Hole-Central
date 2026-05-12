'use client'

import { useEffect, useState, useCallback } from 'react'
import { useSession } from 'next-auth/react'
import StatCard from '@/components/dashboard/StatCard'
import InstanceCard from '@/components/dashboard/InstanceCard'
import BlocksHistoryChart from '@/components/dashboard/BlocksHistoryChart'
import TopDomainsTable from '@/components/instance/TopDomainsTable'
import TopClientsTable from '@/components/instance/TopClientsTable'
import { Button } from '@/components/ui/button'
import { Activity, Shield, ShieldOff, Server, RefreshCw, ShieldCheck, ShieldX } from 'lucide-react'
import { toast } from 'sonner'

interface InstanceData {
  id: string
  name: string
  url: string
  status: 'online' | 'offline'
  summary: {
    queries: { total: number; blocked: number; percent_blocked: number }
  } | null
  blocking: { blocking: 'enabled' | 'disabled' | 'unknown' } | null
}

interface SummaryData {
  instances: InstanceData[]
  aggregated: {
    totalQueries: number
    totalBlocked: number
    blockPct: number
    instancesOnline: number
    instancesTotal: number
  }
}

interface BlockPoint {
  timestamp: number
  blocked: number
  total: number
}

interface TopDomain { domain: string; count: number }
interface TopClient { ip: string; name: string; count: number }

export default function OverviewPage() {
  const { data: session } = useSession()
  const role = session?.user?.role ?? 'viewer'
  const [summary, setSummary] = useState<SummaryData | null>(null)
  const [blocks, setBlocks] = useState<BlockPoint[]>([])
  const [topDomains, setTopDomains] = useState<TopDomain[]>([])
  const [topClients, setTopClients] = useState<TopClient[]>([])
  const [loading, setLoading] = useState(true)
  const [bulkBlocking, setBulkBlocking] = useState(false)
  const [bulkGravity, setBulkGravity] = useState(false)

  const fetchSummary = useCallback(async () => {
    try {
      const res = await fetch('/api/stats/summary')
      if (res.ok) setSummary(await res.json())
    } catch (err) {
      console.error('Failed to fetch summary:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  const fetchBlocks = useCallback(async () => {
    try {
      const res = await fetch('/api/stats/blocks')
      if (res.ok) {
        const { data } = await res.json()
        setBlocks(data ?? [])
      }
    } catch (err) {
      console.error('Failed to fetch blocks history:', err)
    }
  }, [])

  const fetchTop = useCallback(async () => {
    try {
      const res = await fetch('/api/stats/top')
      if (res.ok) {
        const { topDomains, topClients } = await res.json()
        setTopDomains(topDomains ?? [])
        setTopClients(topClients ?? [])
      }
    } catch (err) {
      console.error('Failed to fetch top data:', err)
    }
  }, [])

  useEffect(() => {
    fetchSummary()
    fetchBlocks()
    fetchTop()
  }, [fetchSummary, fetchBlocks, fetchTop])

  const handleBulkBlocking = useCallback(async (enabled: boolean) => {
    setBulkBlocking(true)
    try {
      const res = await fetch('/api/pihole/bulk/blocking', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      })
      const { results } = await res.json()
      const failed = results.filter((r: { ok: boolean }) => !r.ok)
      if (failed.length === 0) {
        toast.success(`Blocking ${enabled ? 'enabled' : 'disabled'} on all instances`)
      } else {
        toast.error(`Failed on ${failed.length} instance(s): ${failed.map((r: { name: string }) => r.name).join(', ')}`)
      }
      fetchSummary()
    } catch {
      toast.error('Bulk blocking request failed')
    } finally {
      setBulkBlocking(false)
    }
  }, [fetchSummary])

  const handleBulkGravity = useCallback(async () => {
    setBulkGravity(true)
    try {
      const res = await fetch('/api/pihole/bulk/gravity', { method: 'POST' })
      const { results } = await res.json()
      const failed = results.filter((r: { ok: boolean }) => !r.ok)
      if (failed.length === 0) {
        toast.success('Gravity update triggered on all instances')
      } else {
        toast.error(`Failed on ${failed.length} instance(s): ${failed.map((r: { name: string }) => r.name).join(', ')}`)
      }
    } catch {
      toast.error('Bulk gravity request failed')
    } finally {
      setBulkGravity(false)
    }
  }, [])

  // SSE for live updates
  useEffect(() => {
    const es = new EventSource('/api/events')
    es.onmessage = (e) => {
      const data = JSON.parse(e.data) as SummaryData
      setSummary(data)
    }
    es.onerror = () => es.close()
    return () => es.close()
  }, [])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-muted-foreground text-sm animate-pulse">Loading...</div>
      </div>
    )
  }

  const agg = summary?.aggregated

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold gradient-text">Overview</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {agg ? `${agg.instancesOnline} of ${agg.instancesTotal} instances online` : 'No instances configured'}
          </p>
        </div>
        {role === 'admin' && (
          <div className="flex items-center gap-2 flex-shrink-0">
            <Button
              size="sm"
              variant="outline"
              onClick={() => handleBulkBlocking(true)}
              disabled={bulkBlocking}
              className="text-green-400 border-green-400/30 hover:bg-green-400/10"
            >
              <ShieldCheck className="h-4 w-4 mr-1.5" />
              Enable All
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => handleBulkBlocking(false)}
              disabled={bulkBlocking}
              className="text-red-400 border-red-400/30 hover:bg-red-400/10"
            >
              <ShieldX className="h-4 w-4 mr-1.5" />
              Disable All
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={handleBulkGravity}
              disabled={bulkGravity}
              className="text-blue-400 border-blue-400/30 hover:bg-blue-400/10"
            >
              <RefreshCw className={`h-4 w-4 mr-1.5 ${bulkGravity ? 'animate-spin' : ''}`} />
              Update Gravity
            </Button>
          </div>
        )}
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          title="Total Queries"
          value={agg?.totalQueries.toLocaleString() ?? '—'}
          subtitle="Today across all instances"
          icon={Activity}
          color="blue"
          delay={0}
        />
        <StatCard
          title="Blocked"
          value={agg?.totalBlocked.toLocaleString() ?? '—'}
          subtitle="Ads & trackers blocked"
          icon={ShieldOff}
          color="red"
          delay={60}
        />
        <StatCard
          title="Block Rate"
          value={agg ? `${agg.blockPct.toFixed(1)}%` : '—'}
          subtitle="Average across online instances"
          icon={Shield}
          color="green"
          delay={120}
        />
        <StatCard
          title="Instances"
          value={agg ? `${agg.instancesOnline}/${agg.instancesTotal}` : '—'}
          subtitle="Online"
          icon={Server}
          color="purple"
          delay={180}
        />
      </div>

      {/* Instance grid */}
      {summary && summary.instances.length > 0 ? (
        <div>
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-3">
            Instances
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {summary.instances.map((inst) => (
              <InstanceCard key={inst.id} instance={inst} onUpdate={fetchSummary} role={role as 'admin' | 'viewer'} />
            ))}
          </div>
        </div>
      ) : (
        <div className="glass-card p-12 text-center space-y-2">
          <Server className="h-10 w-10 text-muted-foreground/50 mx-auto" />
          <p className="text-muted-foreground">No instances configured</p>
          <p className="text-sm text-muted-foreground">
            Go to{' '}
            <a href="/settings/instances" className="text-blue-400 hover:underline">
              Settings → Instances
            </a>{' '}
            to add your first Pi-Hole.
          </p>
        </div>
      )}

      {/* Blocks history chart */}
      <BlocksHistoryChart data={blocks} label="Blocked queries — last 24 hours (10-min intervals)" />

      {/* Aggregated top tables */}
      {(topDomains.length > 0 || topClients.length > 0) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="glass-card p-4">
            <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-3">
              Top Blocked Domains
            </h2>
            <TopDomainsTable domains={topDomains} />
          </div>
          <div className="glass-card p-4">
            <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-3">
              Top Clients
            </h2>
            <TopClientsTable clients={topClients} />
          </div>
        </div>
      )}
    </div>
  )
}
