'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { api, errorText } from '@/lib/client/api'

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

export function StatusPill({ online }: { online: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium',
        online ? 'border-success/25 bg-success/10 text-success' : 'border-destructive/25 bg-destructive/10 text-destructive'
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', online ? 'bg-success' : 'bg-destructive')} aria-hidden />
      {online ? 'Online' : 'Offline'}
    </span>
  )
}

function Metric({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn('num truncate text-lg font-semibold tracking-tight', className)}>{value}</p>
    </div>
  )
}

export default function InstanceCard({ instance, onUpdate, role = 'admin' }: {
  instance: InstanceData
  onUpdate: () => void
  role?: 'admin' | 'viewer'
}) {
  const router = useRouter()
  const [togglingBlocking, setTogglingBlocking] = useState(false)
  const [updatingGravity, setUpdatingGravity] = useState(false)
  const [unboundStatus, setUnboundStatus] = useState<'running' | 'stopped' | 'unknown'>('unknown')

  useEffect(() => {
    if (!instance.sshUsername || role !== 'admin') return
    fetch(`/api/unbound/${instance.id}/status`)
      .then((r) => (r.ok ? r.json() : {}))
      .then((d: { status?: 'running' | 'stopped' | 'unknown' }) => setUnboundStatus(d.status ?? 'unknown'))
      .catch(() => {})
  }, [instance.id, instance.sshUsername, role])

  const isOnline = instance.status === 'online'
  const blockingEnabled = instance.blocking?.blocking === 'enabled'

  // stop card-level navigation when interacting with inner controls
  const stop = (e: React.MouseEvent) => e.stopPropagation()

  async function toggleBlocking(enabled: boolean) {
    setTogglingBlocking(true)
    try {
      await api(`/api/pihole/${instance.id}/blocking`, { method: 'POST', json: { enabled } })
      toast.success(`Blocking ${enabled ? 'enabled' : 'disabled'} on ${instance.name}`)
      onUpdate()
    } catch (err) {
      toast.error(`Failed to toggle blocking on ${instance.name}: ${errorText(err)}`)
    } finally {
      setTogglingBlocking(false)
    }
  }

  async function triggerGravity(e: React.MouseEvent) {
    e.stopPropagation()
    setUpdatingGravity(true)
    const t = toast.loading(`Updating gravity on ${instance.name}…`)
    try {
      const data = await api<{ failedLists?: number; message?: string }>(`/api/pihole/${instance.id}/gravity`, { method: 'POST' })
      if (data.failedLists) toast.warning(`${instance.name}: ${data.message}`, { id: t })
      else toast.success(`Gravity updated on ${instance.name}`, { id: t })
    } catch (err) {
      toast.error(`Gravity failed on ${instance.name}: ${errorText(err)}`, { id: t })
    } finally {
      setUpdatingGravity(false)
    }
  }

  const q = instance.summary?.queries

  return (
    <div
      onClick={() => router.push(`/instances/${instance.id}`)}
      className="surface group flex cursor-pointer flex-col transition-colors hover:border-ring/40"
    >
      <div className="flex items-start justify-between gap-3 p-4 pb-3">
        <div className="min-w-0">
          <Link
            href={`/instances/${instance.id}`}
            onClick={stop}
            className="block truncate rounded-sm font-semibold transition-colors hover:text-primary"
          >
            {instance.name}
          </Link>
          <p className="truncate font-mono text-xs text-muted-foreground" title={instance.url}>
            {instance.url.replace(/^https?:\/\//, '')}
          </p>
        </div>
        <StatusPill online={isOnline} />
      </div>

      <div className="px-4 pb-4">
        {isOnline && q ? (
          <div className="grid grid-cols-3 gap-3">
            <Metric label="Queries" value={q.total.toLocaleString()} />
            <Metric label="Blocked" value={q.blocked.toLocaleString()} />
            <Metric label="Block rate" value={`${q.percent_blocked.toFixed(1)}%`} />
          </div>
        ) : (
          <p className="py-2 text-sm text-muted-foreground">{isOnline ? 'Waiting for the first poll…' : 'Instance unreachable'}</p>
        )}
      </div>

      <div className="mt-auto flex items-center justify-between gap-2 border-t border-border px-4 py-2.5">
        <div className="flex items-center gap-2" onClick={stop}>
          {role === 'admin' ? (
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <Switch
                checked={blockingEnabled}
                onCheckedChange={toggleBlocking}
                disabled={!isOnline || togglingBlocking}
                aria-label={`Ad blocking on ${instance.name}`}
              />
              Blocking
            </label>
          ) : (
            <span className="text-sm text-muted-foreground">
              Blocking{' '}
              <span className={blockingEnabled ? 'text-success' : 'text-destructive'}>{blockingEnabled ? 'on' : 'off'}</span>
            </span>
          )}
        </div>
        {role === 'admin' && (
          <div className="flex items-center gap-1">
            {instance.sshUsername && (
              <Link
                href={`/instances/${instance.id}/unbound`}
                onClick={stop}
                title="Unbound management"
                className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <span
                  aria-hidden
                  className={cn(
                    'h-1.5 w-1.5 rounded-full',
                    unboundStatus === 'running' ? 'bg-success' : unboundStatus === 'stopped' ? 'bg-destructive' : 'bg-muted-foreground/40'
                  )}
                />
                Unbound
                <span className="sr-only">: {unboundStatus}</span>
              </Link>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={triggerGravity}
              disabled={!isOnline || updatingGravity}
              title="Update gravity"
            >
              <RefreshCw className={cn(updatingGravity && 'animate-spin')} />
              Gravity
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
