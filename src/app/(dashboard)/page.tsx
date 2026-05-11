'use client'

import { useEffect, useState, useCallback } from 'react'
import StatCard from '@/components/dashboard/StatCard'
import InstanceCard from '@/components/dashboard/InstanceCard'
import BlockRateChart from '@/components/dashboard/BlockRateChart'
import { Activity, Shield, ShieldOff, Server } from 'lucide-react'

interface InstanceData {
  id: string
  name: string
  url: string
  status: 'online' | 'offline'
  summary: {
    queries: { total: number; blocked: number; percent_blocked: number }
  } | null
  blocking: { blocking: boolean } | null
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

interface HistoryRow {
  instanceId: string
  timestamp: string
  blockPct: number
  status: string
}

export default function OverviewPage() {
  const [summary, setSummary] = useState<SummaryData | null>(null)
  const [history, setHistory] = useState<HistoryRow[]>([])
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

  const fetchHistory = useCallback(async () => {
    try {
      const res = await fetch('/api/stats/history?hours=24')
      if (res.ok) setHistory(await res.json())
    } catch (err) {
      console.error('Failed to fetch history:', err)
    }
  }, [])

  useEffect(() => {
    fetchSummary()
    fetchHistory()
  }, [fetchSummary, fetchHistory])

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

  const instanceNames = Object.fromEntries(
    (summary?.instances ?? []).map((i) => [i.id, i.name])
  )

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

      {/* Block rate chart */}
      <BlockRateChart data={history} instanceNames={instanceNames} />
    </div>
  )
}
