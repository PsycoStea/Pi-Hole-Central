'use client'

import { useEffect, useState, useCallback } from 'react'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import PageHeader from '@/components/dashboard/PageHeader'

interface WatchdogEvent {
  id: number
  instanceId: string
  instanceName: string
  timestamp: string | number
  eventType: string
  detail: string
  success: boolean
}

interface Channel {
  id: string
  type: string
  label: string
  enabled: boolean
}

const EVENT_LABELS: Record<string, string> = {
  watchdog_restart: 'Restart (API down on node)',
  watchdog_elevated: 'Elevated (no restart)',
  watchdog_ceiling: 'Daily limit reached',
}

export default function WatchdogPage() {
  const [enabled, setEnabled] = useState(true)
  const [threshold, setThreshold] = useState(30)
  const [channelIds, setChannelIds] = useState<string[]>([])
  const [channels, setChannels] = useState<Channel[]>([])
  const [events, setEvents] = useState<WatchdogEvent[]>([])
  const [saving, setSaving] = useState(false)

  const fetchData = useCallback(async () => {
    const [watchdogRes, channelsRes] = await Promise.all([
      fetch('/api/watchdog'),
      fetch('/api/notifications/channels'),
    ])
    if (watchdogRes.ok) {
      const data = await watchdogRes.json()
      setEnabled(data.enabled)
      setThreshold(data.threshold)
      setChannelIds(data.channelIds ?? [])
      setEvents(data.events ?? [])
    }
    if (channelsRes.ok) setChannels(await channelsRes.json())
  }, [])

  useEffect(() => { fetchData() }, [fetchData])

  async function save(patch: { enabled?: boolean; threshold?: number; channelIds?: string[] }) {
    setSaving(true)
    try {
      const res = await fetch('/api/watchdog', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        toast.error(err.error ?? 'Failed to save watchdog settings')
      }
    } catch {
      toast.error('Failed to save watchdog settings')
    } finally {
      setSaving(false)
    }
  }

  function toggleChannel(channelId: string) {
    const updated = channelIds.includes(channelId)
      ? channelIds.filter((id) => id !== channelId)
      : [...channelIds, channelId]
    setChannelIds(updated)
    save({ channelIds: updated })
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <PageHeader title="Watchdog" description="Restart pihole-FTL when leaked CLOSE-WAIT connections have broken its API on the node (ports 80 and 443; at most 3 restarts per node per day, never two nodes at once)" />

      {/* Configuration */}
      <div className="surface p-5 space-y-5">
        <p className="text-sm font-medium">Configuration</p>

        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm">Enable watchdog</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Check for stuck connections on every successful poll cycle
            </p>
          </div>
          <Switch
            checked={enabled}
            disabled={saving}
            aria-label="Watchdog enabled"
            onCheckedChange={(v) => {
              setEnabled(v)
              save({ enabled: v })
            }}
          />
        </div>

        <div className="flex items-center gap-3">
          <Label className="text-xs text-muted-foreground whitespace-nowrap">
            Restart threshold
          </Label>
          <Input
            type="number"
            min={1}
            max={200}
            value={threshold}
            disabled={saving}
            onChange={(e) => setThreshold(parseInt(e.target.value, 10))}
            onBlur={() => {
              const t = Math.max(1, Math.min(200, threshold || 30))
              setThreshold(t)
              save({ threshold: t })
            }}
            className="w-24 bg-foreground/5 border-border h-8 text-sm"
          />
          <span className="text-xs text-muted-foreground">
            CLOSE-WAIT connections before checking the node; FTL is restarted only if its API is also down on the node itself (max 200)
          </span>
        </div>
      </div>

      {/* Notifications */}
      <div className="surface p-5 space-y-4">
        <div>
          <p className="text-sm font-medium">Notifications</p>
          <p className="text-xs text-muted-foreground mt-0.5">Notify on watchdog restart</p>
        </div>

        {channels.length === 0 ? (
          <p className="text-xs text-warning/80">
            No notification channels configured. Go to{' '}
            <a href="/settings/notifications" className="underline">Notifications</a>{' '}
            to add a channel first.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {channels.map((ch) => {
              const active = channelIds.includes(ch.id)
              return (
                <Button
                  key={ch.id}
                  variant="ghost"
                  size="sm"
                  disabled={saving}
                  onClick={() => toggleChannel(ch.id)}
                  className={`text-xs h-7 border transition-colors ${
                    active
                      ? 'bg-primary/15 border-primary/30 text-primary'
                      : 'bg-foreground/5 border-border text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {ch.label}
                </Button>
              )
            })}
          </div>
        )}
      </div>

      {/* Recent Events */}
      <div className="surface p-5 space-y-4">
        <p className="text-sm font-medium">Recent Events</p>

        {events.length === 0 ? (
          <p className="text-xs text-muted-foreground">No watchdog events yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[32rem] text-xs">
              <thead>
                <tr className="text-muted-foreground border-b border-border">
                  <th className="text-left pb-2 pr-4 font-medium">Time</th>
                  <th className="text-left pb-2 pr-4 font-medium">Instance</th>
                  <th className="text-left pb-2 pr-4 font-medium">Event</th>
                  <th className="text-left pb-2 pr-4 font-medium">Detail</th>
                  <th className="text-left pb-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {events.map((ev) => (
                  <tr key={ev.id} className="align-top">
                    <td className="py-2 pr-4 whitespace-nowrap text-muted-foreground">
                      {new Date(ev.timestamp).toLocaleString()}
                    </td>
                    <td className="py-2 pr-4 whitespace-nowrap">{ev.instanceName}</td>
                    <td className="py-2 pr-4 whitespace-nowrap">
                      {EVENT_LABELS[ev.eventType] ?? ev.eventType}
                    </td>
                    <td className="py-2 pr-4 text-muted-foreground">{ev.detail}</td>
                    <td className="py-2">
                      <span
                        className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-medium ${
                          ev.success
                            ? 'bg-success/15 text-success'
                            : 'bg-destructive/15 text-destructive'
                        }`}
                      >
                        {ev.success ? 'OK' : 'Failed'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
