'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { ExternalLink, RefreshCw } from 'lucide-react'
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

export default function InstanceCard({ instance, onUpdate, role = 'admin' }: {
  instance: InstanceData
  onUpdate: () => void
  role?: 'admin' | 'viewer'
}) {
  const [togglingBlocking, setTogglingBlocking] = useState(false)
  const [updatingGravity, setUpdatingGravity] = useState(false)

  const isOnline = instance.status === 'online'
  const blockingEnabled = instance.blocking?.blocking === 'enabled'

  async function toggleBlocking(enabled: boolean) {
    setTogglingBlocking(true)
    try {
      const res = await fetch(`/api/pihole/${instance.id}/blocking`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      })
      if (!res.ok) throw new Error('Failed')
      toast.success(`Blocking ${enabled ? 'enabled' : 'disabled'} on ${instance.name}`)
      onUpdate()
    } catch {
      toast.error(`Failed to toggle blocking on ${instance.name}`)
    } finally {
      setTogglingBlocking(false)
    }
  }

  async function triggerGravity() {
    setUpdatingGravity(true)
    try {
      await fetch(`/api/pihole/${instance.id}/gravity`, { method: 'POST' })
      toast.success(`Gravity update triggered on ${instance.name}`)
    } catch {
      toast.error('Failed to trigger gravity update')
    } finally {
      setUpdatingGravity(false)
    }
  }

  return (
    <div className={cn(
      'glass-card p-5 space-y-4 animate-fade-in-up',
      !isOnline && 'opacity-70'
    )}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <Link
            href={`/instances/${instance.id}`}
            className="font-semibold text-sm hover:text-blue-400 transition-colors"
          >
            {instance.name}
          </Link>
          <p className="text-xs text-muted-foreground truncate">{instance.url}</p>
        </div>
        <Badge
          className={cn(
            'shrink-0 text-xs',
            isOnline
              ? 'bg-green-500/15 text-green-400 border-green-500/25 glow-green-sm'
              : 'bg-red-500/15 text-red-400 border-red-500/25'
          )}
        >
          {isOnline ? 'Online' : 'Offline'}
        </Badge>
      </div>

      {isOnline && instance.summary && (
        <div className="grid grid-cols-3 gap-3">
          <div className="text-center">
            <p className="text-lg font-bold">{instance.summary.queries.total.toLocaleString()}</p>
            <p className="text-xs text-muted-foreground">Queries</p>
          </div>
          <div className="text-center">
            <p className="text-lg font-bold text-red-400">{instance.summary.queries.blocked.toLocaleString()}</p>
            <p className="text-xs text-muted-foreground">Blocked</p>
          </div>
          <div className="text-center">
            <p className="text-lg font-bold text-green-400">{instance.summary.queries.percent_blocked.toFixed(1)}%</p>
            <p className="text-xs text-muted-foreground">Block %</p>
          </div>
        </div>
      )}

      {!isOnline && (
        <p className="text-sm text-muted-foreground text-center py-2">Instance unreachable</p>
      )}

      <div className="flex items-center justify-between pt-1 border-t border-border">
        <div className="flex items-center gap-2">
          {role === 'admin' ? (
            <>
              <Switch
                checked={blockingEnabled}
                onCheckedChange={toggleBlocking}
                disabled={!isOnline || togglingBlocking}
                className="scale-90"
              />
              <span className="text-xs text-muted-foreground">Blocking</span>
            </>
          ) : (
            <span className="text-xs text-muted-foreground">
              Blocking: <span className={blockingEnabled ? 'text-green-400' : 'text-red-400'}>{blockingEnabled ? 'On' : 'Off'}</span>
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {role === 'admin' && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-foreground"
              onClick={triggerGravity}
              disabled={!isOnline || updatingGravity}
              title="Update gravity"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', updatingGravity && 'animate-spin')} />
            </Button>
          )}
          <Link href={`/instances/${instance.id}`}>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-foreground"
              title="View details"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </Button>
          </Link>
        </div>
      </div>
    </div>
  )
}
