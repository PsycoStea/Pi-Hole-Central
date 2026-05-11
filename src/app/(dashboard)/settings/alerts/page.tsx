'use client'

import { useEffect, useState, useCallback } from 'react'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'

interface AlertSetting {
  id: string
  type: string
  enabled: boolean
  threshold: number | null
  channelIdsJson: string
}

interface Channel {
  id: string
  type: string
  label: string
  enabled: boolean
}

const ALERT_META: Record<string, { title: string; description: string }> = {
  offline: {
    title: 'Instance Offline',
    description: 'Alert when a Pi-Hole instance stops responding',
  },
  blocking_disabled: {
    title: 'Blocking Disabled',
    description: 'Alert when ad blocking is turned off on any instance',
  },
  block_rate_low: {
    title: 'Low Block Rate',
    description: 'Alert when the block rate falls below a threshold',
  },
  recovery: {
    title: 'Instance Recovered',
    description: 'Alert when an offline instance comes back online',
  },
}

export default function AlertsPage() {
  const [alerts, setAlerts] = useState<AlertSetting[]>([])
  const [channels, setChannels] = useState<Channel[]>([])
  const [saving, setSaving] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    const [alertsRes, channelsRes] = await Promise.all([
      fetch('/api/alerts'),
      fetch('/api/notifications/channels'),
    ])
    if (alertsRes.ok) setAlerts(await alertsRes.json())
    if (channelsRes.ok) setChannels(await channelsRes.json())
  }, [])

  useEffect(() => { fetchData() }, [fetchData])

  async function updateAlert(alert: AlertSetting, changes: Partial<AlertSetting>) {
    setSaving(alert.id)
    try {
      const updated = { ...alert, ...changes }
      await fetch('/api/alerts', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: alert.id,
          enabled: updated.enabled,
          threshold: updated.threshold,
          channelIds: JSON.parse(updated.channelIdsJson),
        }),
      })
      setAlerts((prev) => prev.map((a) => (a.id === alert.id ? { ...a, ...changes } : a)))
    } catch {
      toast.error('Failed to save alert settings')
    } finally {
      setSaving(null)
    }
  }

  function toggleChannel(alert: AlertSetting, channelId: string) {
    const current: string[] = JSON.parse(alert.channelIdsJson)
    const updated = current.includes(channelId)
      ? current.filter((id) => id !== channelId)
      : [...current, channelId]
    updateAlert(alert, { channelIdsJson: JSON.stringify(updated) })
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold">Alerts</h1>
        <p className="text-sm text-white/40 mt-0.5">Configure conditions and delivery for notifications</p>
      </div>

      {channels.length === 0 && (
        <div className="glass-card p-4 text-sm text-amber-400/80 border border-amber-500/20 bg-amber-500/5">
          No notification channels configured. Go to{' '}
          <a href="/settings/notifications" className="underline">Notifications</a>{' '}
          to add a channel before enabling alerts.
        </div>
      )}

      <div className="space-y-4">
        {alerts.map((alert) => {
          const meta = ALERT_META[alert.type]
          if (!meta) return null
          const channelIds: string[] = JSON.parse(alert.channelIdsJson)
          return (
            <div key={alert.id} className="glass-card p-5 space-y-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="font-medium text-sm">{meta.title}</p>
                  <p className="text-xs text-white/40 mt-0.5">{meta.description}</p>
                </div>
                <Switch
                  checked={alert.enabled}
                  onCheckedChange={(v) => updateAlert(alert, { enabled: v })}
                  disabled={saving === alert.id}
                />
              </div>

              {alert.type === 'block_rate_low' && alert.enabled && (
                <div className="flex items-center gap-3">
                  <Label className="text-xs text-white/50 whitespace-nowrap">Threshold (%)</Label>
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    value={alert.threshold ?? 5}
                    onChange={(e) => updateAlert(alert, { threshold: parseFloat(e.target.value) })}
                    className="w-24 bg-white/5 border-white/10 h-8 text-sm"
                  />
                  <span className="text-xs text-white/30">Alert when block rate drops below this value</span>
                </div>
              )}

              {alert.enabled && channels.length > 0 && (
                <div>
                  <p className="text-xs text-white/40 mb-2">Deliver via:</p>
                  <div className="flex flex-wrap gap-2">
                    {channels.map((ch) => {
                      const active = channelIds.includes(ch.id)
                      return (
                        <Button
                          key={ch.id}
                          variant="ghost"
                          size="sm"
                          onClick={() => toggleChannel(alert, ch.id)}
                          className={`text-xs h-7 border transition-all ${
                            active
                              ? 'bg-blue-500/15 border-blue-500/30 text-blue-300'
                              : 'bg-white/5 border-white/10 text-white/40 hover:text-white'
                          }`}
                        >
                          {ch.label}
                        </Button>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
