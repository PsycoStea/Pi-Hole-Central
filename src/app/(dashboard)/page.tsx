'use client'

import { useEffect, useState, useCallback } from 'react'
import StatCard from '@/components/dashboard/StatCard'
import InstanceCard from '@/components/dashboard/InstanceCard'
import BlocksHistoryChart from '@/components/dashboard/BlocksHistoryChart'
import TopDomainsTable from '@/components/instance/TopDomainsTable'
import TopClientsTable from '@/components/instance/TopClientsTable'
import { Activity, Shield, ShieldOff, Server } from 'lucide-react'

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
  const [summary, setSummary] = useState<SummaryData | null>(null)
  const [blocks, setBlocks] = useState<BlockPoint[]>([])
  const [topDomains, setTopDomains] = useState<TopDomain[]>([])
  const [topClients, setTopClients] = useState<TopClient[]>([])
  const [loading, setLoading] = useState(true)

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
        <div className="text-white/30 text-sm animate-pulse">Loading...</div>
      </div>
    )
  }

  const agg = summary?.aggregated

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Overview</h1>
        <p className="text-sm text-white/40 mt-0.5">
          {agg ? `${agg.instancesOnline} of ${agg.instancesTotal} instances online` : 'No instances configured'}
        </p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          title="Total Queries"
          value={agg?.totalQueries.toLocaleString() ?? '—'}
          subtitle="Today across all instances"
          icon={Activity}
          color="blue"
        />
        <StatCard
          title="Blocked"
          value={agg?.totalBlocked.toLocaleString() ?? '—'}
          subtitle="Ads & trackers blocked"
          icon={ShieldOff}
          color="red"
        />
        <StatCard
          title="Block Rate"
          value={agg ? `${agg.blockPct.toFixed(1)}%` : '—'}
          subtitle="Average across online instances"
          icon={Shield}
          color="green"
        />
        <StatCard
          title="Instances"
          value={agg ? `${agg.instancesOnline}/${agg.instancesTotal}` : '—'}
          subtitle="Online"
          icon={Server}
          color="purple"
        />
      </div>

      {/* Instance grid */}
      {summary && summary.instances.length > 0 ? (
        <div>
          <h2 className="text-sm font-medium text-white/50 uppercase tracking-wider mb-3">
            Instances
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {summary.instances.map((inst) => (
              <InstanceCard key={inst.id} instance={inst} onUpdate={fetchSummary} />
            ))}
          </div>
        </div>
      ) : (
        <div className="glass-card p-12 text-center space-y-2">
          <Server className="h-10 w-10 text-white/20 mx-auto" />
          <p className="text-white/50">No instances configured</p>
          <p className="text-sm text-white/30">
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
            <h2 className="text-sm font-medium text-white/50 uppercase tracking-wider mb-3">
              Top Blocked Domains
            </h2>
            <TopDomainsTable domains={topDomains} />
          </div>
          <div className="glass-card p-4">
            <h2 className="text-sm font-medium text-white/50 uppercase tracking-wider mb-3">
              Top Clients
            </h2>
            <TopClientsTable clients={topClients} />
          </div>
        </div>
      )}
    </div>
  )
}
