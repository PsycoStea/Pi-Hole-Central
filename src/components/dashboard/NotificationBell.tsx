'use client'

import { useEffect, useState, useCallback } from 'react'
import { toast } from 'sonner'
import { api, errorText } from '@/lib/client/api'
import Link from 'next/link'
import { Bell } from 'lucide-react'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

interface NotificationRow {
  id: number
  type: string
  severity: 'info' | 'warning' | 'critical'
  title: string
  message: string
  read: boolean
  timestamp: string
}

const SEVERITY_DOT: Record<string, string> = {
  info: 'bg-primary',
  warning: 'bg-warning',
  critical: 'bg-destructive',
}

export default function NotificationBell({ rail = false }: { rail?: boolean }) {
  const [unread, setUnread] = useState(0)
  const [items, setItems] = useState<NotificationRow[]>([])
  // Live conditions are shown above the feed and counted in the badge even once
  // read — an ongoing problem should not vanish just because it was glanced at.
  const [active, setActive] = useState<NotificationRow[]>([])
  const [open, setOpen] = useState(false)

  const fetchUnread = useCallback(async () => {
    try {
      const r = await fetch('/api/notifications?unread=1')
      if (r.ok) setUnread((await r.json()).count ?? 0)
    } catch {
      /* transient — keep last count */
    }
  }, [])

  const fetchItems = useCallback(async () => {
    try {
      const r = await fetch('/api/notifications?limit=10')
      if (r.ok) {
        const d = await r.json()
        setItems(d.notifications ?? [])
        setActive(d.active ?? [])
        setUnread((d.unread ?? 0) + (d.active?.length ?? 0))
      }
    } catch {
      /* ignore */
    }
  }, [])

  // Poll the unread badge (SSE carries only the poll summary, so poll here).
  useEffect(() => {
    fetchUnread()
    const id = setInterval(fetchUnread, 45_000)
    return () => clearInterval(id)
  }, [fetchUnread])

  useEffect(() => {
    if (open) fetchItems()
  }, [open, fetchItems])

  const markAllRead = async () => {
    try {
      await api('/api/notifications/mark-read', { method: 'POST', json: { all: true } })
      setUnread(active.length)
      setItems((prev) => prev.map((n) => ({ ...n, read: true })))
    } catch (err) {
      toast.error(errorText(err, 'Could not mark notifications read'))
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            aria-label={unread > 0 ? `Notifications (${unread} unread)` : 'Notifications'}
            className="relative p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer"
          />
        }
      >
        <Bell className="h-4 w-4" />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 min-w-4 h-4 px-1 rounded-full bg-destructive text-destructive-foreground text-[10px] leading-4 font-semibold text-center">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent align={rail ? 'start' : 'end'} className="w-80 p-0">
        <div className="flex items-center justify-between px-3 py-2 border-b border-border">
          <span className="text-sm font-medium">Notifications</span>
          {unread > 0 && (
            <button
              onClick={markAllRead}
              className="text-xs text-muted-foreground hover:text-foreground cursor-pointer"
            >
              Mark all read
            </button>
          )}
        </div>
        <div className="max-h-96 overflow-y-auto">
          {active.map((n) => (
            <div
              key={`active-${n.id}`}
              className="flex items-start gap-2.5 px-3 py-2.5 border-b border-border/50 bg-warning/[0.06]"
            >
              <span className={cn('mt-1.5 h-2 w-2 rounded-full shrink-0 animate-pulse', SEVERITY_DOT[n.severity] ?? 'bg-muted-foreground')} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <p className="text-sm font-medium leading-tight">{n.title}</p>
                  <span className="text-[9px] uppercase tracking-wide text-warning border border-warning/40 rounded px-1 shrink-0">
                    ongoing
                  </span>
                </div>
                {n.message && <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{n.message}</p>}
              </div>
            </div>
          ))}
          {items.length === 0 && active.length === 0 ? (
            <p className="text-muted-foreground text-sm text-center py-8">No notifications</p>
          ) : (
            items.map((n) => (
              <div
                key={n.id}
                className={cn(
                  'flex items-start gap-2.5 px-3 py-2.5 border-b border-border/50',
                  !n.read && 'bg-foreground/[0.03]'
                )}
              >
                <span className={cn('mt-1.5 h-2 w-2 rounded-full shrink-0', SEVERITY_DOT[n.severity] ?? 'bg-muted-foreground')} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium leading-tight">{n.title}</p>
                  {n.message && <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{n.message}</p>}
                  <p className="text-[11px] text-muted-foreground/70 mt-1">
                    {new Date(n.timestamp).toLocaleString()}
                  </p>
                </div>
              </div>
            ))
          )}
        </div>
        <div className="px-3 py-2 border-t border-border">
          <Link
            href="/notifications"
            onClick={() => setOpen(false)}
            className="text-xs text-primary hover:text-primary"
          >
            View all →
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  )
}
