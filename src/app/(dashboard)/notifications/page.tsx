'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { api, errorText } from '@/lib/client/api'
import { Check, Trash2, Circle, AlertCircle } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import PageHeader from '@/components/dashboard/PageHeader'

interface NotificationRow {
  id: number
  type: string
  severity: 'info' | 'warning' | 'critical'
  title: string
  message: string
  read: boolean
  pushed: boolean
  timestamp: string
  sticky?: boolean
  raisedAt?: string | null
  resolvedAt?: string | null
}

const SEVERITY_DOT: Record<string, string> = {
  info: 'bg-primary',
  warning: 'bg-warning',
  critical: 'bg-destructive',
}

const PAGE = 30

export default function NotificationsPage() {
  const [items, setItems] = useState<NotificationRow[]>([])
  const [active, setActive] = useState<NotificationRow[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [severity, setSeverity] = useState('')
  const [read, setRead] = useState('')
  const [loading, setLoading] = useState(true)

  const fetchPage = useCallback(
    async (reset: boolean) => {
      setLoading(true)
      const params = new URLSearchParams()
      params.set('limit', String(PAGE))
      params.set('offset', String(reset ? 0 : offset))
      if (severity) params.set('severity', severity)
      if (read) params.set('read', read)
      try {
        const r = await fetch(`/api/notifications?${params}`)
        if (r.ok) {
          const d = await r.json()
          setItems((prev) => (reset ? d.notifications : [...prev, ...d.notifications]))
          setActive(d.active ?? [])
          setTotal(d.total ?? 0)
          setOffset((reset ? 0 : offset) + (d.notifications?.length ?? 0))
        }
      } catch {
        toast.error('Failed to load notifications')
      } finally {
        setLoading(false)
      }
    },
    [offset, severity, read]
  )

  // Reload from the top whenever a filter changes.
  useEffect(() => {
    fetchPage(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [severity, read])

  // Optimistic updates roll back (via a reload) if the server refuses.
  const markRead = async (id: number, value: boolean) => {
    setItems((prev) => prev.map((n) => (n.id === id ? { ...n, read: value } : n)))
    try {
      await api('/api/notifications/mark-read', { method: 'POST', json: { ids: [id], read: value } })
    } catch (err) {
      toast.error(errorText(err, 'Could not update notification'))
      fetchPage(true)
    }
  }

  const markAllRead = async () => {
    try {
      await api('/api/notifications/mark-read', { method: 'POST', json: { all: true } })
    } catch (err) {
      toast.error(errorText(err, 'Could not mark all read'))
    }
    fetchPage(true)
  }

  const deleteOne = async (id: number) => {
    setItems((prev) => prev.filter((n) => n.id !== id))
    setTotal((t) => Math.max(0, t - 1))
    try {
      await api('/api/notifications', { method: 'DELETE', json: { ids: [id] } })
    } catch (err) {
      toast.error(errorText(err, 'Could not delete notification'))
      fetchPage(true)
    }
  }

  const clear = async (scope: 'read' | 'all') => {
    if (scope === 'all' && !confirm('Delete ALL notifications?')) return
    try {
      await api('/api/notifications', { method: 'DELETE', json: { scope } })
      toast.success(scope === 'all' ? 'All notifications cleared' : 'Read notifications cleared')
    } catch (err) {
      toast.error(errorText(err, 'Could not clear notifications'))
    }
    fetchPage(true)
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <PageHeader
        title="Notifications"
        description="In-app alert history across all instances."
        actions={
          <>
            <div className="flex items-center gap-2">
          <Button variant="outline" onClick={markAllRead} className="gap-1.5">
            <Check className="h-3.5 w-3.5" /> Mark all read
          </Button>
          <Button variant="outline" onClick={() => clear('read')}>Clear read</Button>
          <Button variant="outline" onClick={() => clear('all')} className="text-destructive">Clear all</Button>
        </div>
          </>
        }
      />

      {active.length > 0 && (
        <section className="space-y-2">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4 text-warning" />
            <h2 className="text-sm font-semibold">Active now</h2>
            <span className="text-xs text-muted-foreground">
              {active.length} ongoing {active.length === 1 ? 'condition' : 'conditions'}
            </span>
          </div>
          <p className="text-xs text-muted-foreground/70">
            These stay listed until the condition clears, and update in place rather than
            repeating. They can&apos;t be dismissed — resolve the underlying problem and they go away.
          </p>
          {active.map((n) => (
            <div
              key={n.id}
              className={cn(
                'flex items-start gap-3 p-3 rounded-lg border surface',
                n.severity === 'critical'
                  ? 'border-destructive/40 ring-1 ring-destructive/20'
                  : 'border-warning/40 ring-1 ring-warning/20'
              )}
            >
              <span
                className={cn(
                  'mt-1.5 h-2.5 w-2.5 rounded-full shrink-0 animate-pulse',
                  SEVERITY_DOT[n.severity] ?? 'bg-muted-foreground'
                )}
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="font-medium">{n.title}</p>
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground border border-border rounded px-1.5 py-0.5">
                    {n.type.replace(/_/g, ' ')}
                  </span>
                  <span className="text-[10px] uppercase tracking-wide text-warning border border-warning/40 rounded px-1.5 py-0.5">
                    ongoing
                  </span>
                </div>
                {n.message && <p className="text-sm text-muted-foreground mt-0.5">{n.message}</p>}
                <p className="text-xs text-muted-foreground/70 mt-1">
                  {n.raisedAt
                    ? `since ${new Date(n.raisedAt).toLocaleString()} (${formatDistanceToNow(new Date(n.raisedAt))})`
                    : new Date(n.timestamp).toLocaleString()}
                  {' · rechecked '}
                  {formatDistanceToNow(new Date(n.timestamp), { addSuffix: true })}
                </p>
              </div>
            </div>
          ))}
        </section>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <select
          value={severity}
          onChange={(e) => setSeverity(e.target.value)}
          className="h-9 rounded-lg bg-background border border-border text-foreground text-sm px-3"
        >
          <option value="">All severities</option>
          <option value="info">Info</option>
          <option value="warning">Warning</option>
          <option value="critical">Critical</option>
        </select>
        <select
          value={read}
          onChange={(e) => setRead(e.target.value)}
          className="h-9 rounded-lg bg-background border border-border text-foreground text-sm px-3"
        >
          <option value="">All</option>
          <option value="false">Unread</option>
          <option value="true">Read</option>
        </select>
        <span className="text-xs text-muted-foreground ml-auto">{total} total</span>
      </div>

      <div className="space-y-2">
        {items.length === 0 && !loading ? (
          <p className="text-muted-foreground text-sm text-center py-12">No notifications</p>
        ) : (
          items.map((n) => (
            <div
              key={n.id}
              className={cn(
                'flex items-start gap-3 p-3 rounded-lg border surface',
                !n.read && 'ring-1 ring-ring/20'
              )}
            >
              <span className={cn('mt-1.5 h-2.5 w-2.5 rounded-full shrink-0', SEVERITY_DOT[n.severity] ?? 'bg-muted-foreground')} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="font-medium">{n.title}</p>
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground border border-border rounded px-1.5 py-0.5">
                    {n.type.replace(/_/g, ' ')}
                  </span>
                </div>
                {n.message && <p className="text-sm text-muted-foreground mt-0.5">{n.message}</p>}
                <p className="text-xs text-muted-foreground/70 mt-1">{new Date(n.timestamp).toLocaleString()}</p>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={n.read ? 'Mark unread' : 'Mark read'}
                  title={n.read ? 'Mark unread' : 'Mark read'}
                  onClick={() => markRead(n.id, !n.read)}
                >
                  {n.read ? <Circle className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5" />}
                </Button>
                <Button variant="ghost" size="icon-sm" aria-label="Delete" title="Delete" onClick={() => deleteOne(n.id)}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))
        )}
      </div>

      {items.length < total && (
        <div className="flex justify-center">
          <Button variant="outline" size="sm" onClick={() => fetchPage(false)} disabled={loading}>
            {loading ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}
    </div>
  )
}
