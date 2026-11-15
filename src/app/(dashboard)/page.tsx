'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { useSession } from 'next-auth/react'
import StatCard from '@/components/dashboard/StatCard'
import InstanceCard from '@/components/dashboard/InstanceCard'
import BlocksHistoryChart from '@/components/dashboard/BlocksHistoryChart'
import TopDomainsTable from '@/components/instance/TopDomainsTable'
import TopClientsTable from '@/components/instance/TopClientsTable'
import { Button } from '@/components/ui/button'
import { Activity, Shield, ShieldOff, Server, RefreshCw, ShieldCheck, ShieldX, ChevronDown } from 'lucide-react'
import Link from 'next/link'
import PageHeader from '@/components/dashboard/PageHeader'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { toast } from 'sonner'
import { runBulkBlocking, runBulkGravity } from '@/lib/client/bulk-actions'

interface InstanceData {
  id: string
  name: string
  url: string
  sshUsername?: string | null
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
  // false while the live-update stream is down or silent; the server pushes
  // every 30s, so 75s with nothing means the data on screen is stale.
  const [live, setLive] = useState(true)

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

  useEffect(() => {
    if (sessionStorage.getItem('update-toast-shown')) return
    fetch('/api/update-status')
      .then((r) => (r.ok ? r.json() : {}))
      .then((data: { updates?: { name: string }[] }) => {
        if (data.updates?.length) {
          toast.info(
            `Pi-Hole update available for: ${data.updates.map((u: { name: string }) => u.name).join(', ')}`,
            { duration: 8000 }
          )
          sessionStorage.setItem('update-toast-shown', '1')
        }
      })
      .catch(() => {})
  }, [])

  const handleBulkBlocking = useCallback(async (enabled: boolean) => {
    setBulkBlocking(true)
    try {
      if (await runBulkBlocking(enabled)) fetchSummary()
    } finally {
      setBulkBlocking(false)
    }
  }, [fetchSummary])

  const handleBulkGravity = useCallback(async () => {
    setBulkGravity(true)
    try {
      await runBulkGravity()
    } finally {
      setBulkGravity(false)
    }
  }, [])

  // Live updates over SSE. The browser retries a dropped connection by itself,
  // but gives up for good (readyState CLOSED) on a non-200 or redirect, e.g.
  // while the app is restarting after a deploy. So: reconnect by hand with
  // backoff when CLOSED, show a stale banner while down or silent, and
  // refetch everything once the stream is back.
  const fetchAllRef = useRef(() => {})
  fetchAllRef.current = () => { fetchSummary(); fetchBlocks(); fetchTop() }
  useEffect(() => {
    let es: EventSource | null = null
    let retry: ReturnType<typeof setTimeout> | null = null
    let watchdog: ReturnType<typeof setTimeout> | null = null
    let delay = 2000
    let wasDown = false
    let disposed = false

    const armWatchdog = () => {
      if (watchdog) clearTimeout(watchdog)
      watchdog = setTimeout(() => { wasDown = true; setLive(false) }, 75_000)
    }
    const connect = () => {
      if (disposed) return
      es = new EventSource('/api/events')
      armWatchdog()
      es.onopen = () => {
        delay = 2000
        if (wasDown) { wasDown = false; fetchAllRef.current() }
        setLive(true)
      }
      es.onmessage = (e) => {
        armWatchdog()
        setLive(true)
        try {
          setSummary(JSON.parse(e.data) as SummaryData)
        } catch {
          // Ignore malformed frames rather than throwing inside the callback.
        }
      }
      es.onerror = () => {
        wasDown = true
        setLive(false)
        if (es?.readyState === EventSource.CLOSED) {
          es.close()
          retry = setTimeout(connect, delay)
          delay = Math.min(delay * 2, 30_000)
        }
      }
    }
    connect()
    return () => {
      disposed = true
      if (retry) clearTimeout(retry)
      if (watchdog) clearTimeout(watchdog)
      es?.close()
    }
  }, [])

  if (loading) {
    return (
      <div className="space-y-6" aria-busy="true">
        <PageHeader title="Overview" description="Loading…" />
        <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="surface h-[118px] animate-pulse motion-reduce:animate-none" />
          ))}
        </div>
      </div>
    )
  }

  const agg = summary?.aggregated
  const instances = summary?.instances ?? []

  return (
    <div className="space-y-6">
      <PageHeader
        title="Overview"
        description={
          <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>{agg ? `${agg.instancesOnline} of ${agg.instancesTotal} instances online` : 'No instances configured'}</span>
            {!live && (
              <span role="status" className="inline-flex items-center gap-1.5 text-warning">
                <span className="h-1.5 w-1.5 rounded-full bg-warning" aria-hidden />
                Live updates paused, reconnecting…
              </span>
            )}
          </span>
        }
        actions={
          role === 'admin' && (
            <>
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="outline" disabled={bulkBlocking} />}>
                  <Shield />
                  Blocking
                  <ChevronDown className="text-muted-foreground" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-44">
                  <DropdownMenuItem onClick={() => handleBulkBlocking(true)}>
                    <ShieldCheck />
                    Enable All
                  </DropdownMenuItem>
                  <DropdownMenuItem variant="destructive" onClick={() => handleBulkBlocking(false)}>
                    <ShieldX />
                    Disable All
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button onClick={handleBulkGravity} disabled={bulkGravity}>
                <RefreshCw className={bulkGravity ? 'animate-spin' : undefined} />
                Update Gravity
              </Button>
            </>
          )
        }
      />

      {/* Summary */}
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatCard
          title="Total queries"
          value={agg?.totalQueries.toLocaleString() ?? '—'}
          subtitle="Today, all instances"
          icon={Activity}
          tone="primary"
        />
        <StatCard
          title="Blocked"
          value={agg?.totalBlocked.toLocaleString() ?? '—'}
          subtitle="Ads and trackers"
          icon={ShieldOff}
          tone="destructive"
        />
        <StatCard
          title="Block rate"
          value={agg ? `${agg.blockPct.toFixed(1)}%` : '—'}
          subtitle="Online instances"
          icon={Shield}
          tone="success"
        />
        <StatCard
          title="Instances"
          value={agg ? `${agg.instancesOnline}/${agg.instancesTotal}` : '—'}
          subtitle="Online"
          icon={Server}
        />
      </div>

      {/* Instances */}
      <section aria-labelledby="instances-heading" className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h2 id="instances-heading" className="text-sm font-semibold">Instances</h2>
          {role === 'admin' && (
            <Link href="/settings/instances" className="rounded-sm text-sm text-muted-foreground transition-colors hover:text-foreground">
              Manage
            </Link>
          )}
        </div>
        {instances.length > 0 ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 xl:grid-cols-3">
            {instances.map((inst) => (
              <InstanceCard key={inst.id} instance={inst} onUpdate={fetchSummary} role={role as 'admin' | 'viewer'} />
            ))}
          </div>
        ) : (
          <div className="surface flex flex-col items-center gap-2 px-6 py-12 text-center">
            <Server className="h-8 w-8 text-muted-foreground/60" aria-hidden />
            <p className="font-medium">No instances yet</p>
            <p className="text-sm text-muted-foreground">
              Add your first Pi-hole under{' '}
              <Link href="/settings/instances" className="text-primary hover:underline">
                Instances
              </Link>
              .
            </p>
          </div>
        )}
      </section>

      {/* Activity */}
      <BlocksHistoryChart data={blocks} label="Queries, last 24 hours" />

      <div className="grid grid-cols-1 gap-3 sm:gap-4 lg:grid-cols-2">
        <section className="surface p-4 sm:p-5">
          <h2 className="mb-1 text-sm font-semibold">Top domains</h2>
          <div className="max-h-[360px] overflow-y-auto">
            <TopDomainsTable domains={topDomains} />
          </div>
        </section>
        <section className="surface p-4 sm:p-5">
          <h2 className="mb-1 text-sm font-semibold">Top clients</h2>
          <div className="max-h-[360px] overflow-y-auto">
            <TopClientsTable clients={topClients} />
          </div>
        </section>
      </div>
    </div>
  )
}
