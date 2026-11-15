'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { api, errorText } from '@/lib/client/api'
import PageHeader from '@/components/dashboard/PageHeader'

interface AlertSetting {
  id: string
  type: string
  enabled: boolean
  threshold: number | null
  channelIdsJson: string
  pushEnabled: boolean
  minPushSeverity: 'info' | 'warning' | 'critical'
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
  sd_health: {
    title: 'Disk / SD-Card Health',
    description: 'Alert when a node’s disk is nearly full or its root filesystem goes read-only (SD-card failure), or when the Pi-hole Central host itself runs low on disk',
  },
  cert_expiry: {
    title: 'DoT Certificate Expiry',
    description: 'Alert when an Unbound DoT upstream’s TLS certificate is close to expiring',
  },
  node_tls_cert: {
    title: 'Node HTTPS Certificate',
    description: 'Alert when an https node’s certificate expires within 30 days (critical within 7) or no longer verifies against your CA (PIHOLE_CA_PATH); Pi-hole never renews these certificates itself',
  },
  latency_high: {
    title: 'High DNS Latency',
    description: 'Alert when the recursor’s query response time exceeds the threshold',
  },
  watchdog_restart: {
    title: 'Watchdog Restart',
    description: 'Alert when the CLOSE-WAIT watchdog preventively restarts pihole-FTL',
  },
  nebula_sync_drift: {
    title: 'Nebula-Sync Drift',
    description: 'Alert when node configurations diverge (nebula-sync may be failing)',
  },
  unbound_down: {
    title: 'Unbound Down',
    description: 'Alert when Unbound (the local resolver on a node) is stopped or not answering for two checks in a row, so the node can only answer names it already has cached',
  },
  ssh_host_key: {
    title: 'SSH Host Key Changed',
    description: 'Alert when a node (or the nebula-sync host) presents a different SSH host key than the one pinned; SSH to it is refused until the pin is checked and forgotten',
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

  // Saves for one alert run one after another, each built from the latest
  // saved state (not the render-time copy). Before this, two quick clicks on
  // two channel buttons both started from the same old list, and the second
  // save silently dropped the first channel.
  const savedRef = useRef<AlertSetting[]>([])
  useEffect(() => { savedRef.current = alerts }, [alerts])
  const queueRef = useRef<Record<string, Promise<void>>>({})

  function updateAlert(alert: AlertSetting, changes: Partial<AlertSetting> | ((cur: AlertSetting) => Partial<AlertSetting>)) {
    const id = alert.id
    const run = async () => {
      const cur = savedRef.current.find((a) => a.id === id) ?? alert
      const delta = typeof changes === 'function' ? changes(cur) : changes
      const updated = { ...cur, ...delta }
      setSaving(id)
      try {
        await api('/api/alerts', {
          method: 'PUT',
          json: {
            id,
            enabled: updated.enabled,
            threshold: updated.threshold,
            channelIds: JSON.parse(updated.channelIdsJson),
            pushEnabled: updated.pushEnabled,
            minPushSeverity: updated.minPushSeverity,
          },
        })
        // Only reflect the change once the server has accepted it.
        savedRef.current = savedRef.current.map((a) => (a.id === id ? updated : a))
        setAlerts(savedRef.current)
      } catch (err) {
        toast.error(`Failed to save alert settings: ${errorText(err)}`)
      } finally {
        setSaving((s) => (s === id ? null : s))
      }
    }
    const next = (queueRef.current[id] ?? Promise.resolve()).then(run)
    queueRef.current[id] = next
    return next
  }

  function toggleChannel(alert: AlertSetting, channelId: string) {
    updateAlert(alert, (cur) => {
      const current: string[] = JSON.parse(cur.channelIdsJson)
      const updated = current.includes(channelId)
        ? current.filter((id) => id !== channelId)
        : [...current, channelId]
      return { channelIdsJson: JSON.stringify(updated) }
    })
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <PageHeader title="Alerts" description="Configure conditions and delivery for notifications" />

      {channels.length === 0 && (
        <div className="rounded-xl border border-warning/25 bg-warning/5 p-4 text-sm text-warning">
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
            <div key={alert.id} className="surface p-5 space-y-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="font-medium text-sm">{meta.title}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{meta.description}</p>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <Switch
                    checked={alert.enabled}
                    onCheckedChange={(v) => updateAlert(alert, { enabled: v })}
                    disabled={saving === alert.id}
                    aria-label={`${meta.title} alert enabled`}
                  />
                  <span className="text-[10px] text-muted-foreground">In-app</span>
                </div>
              </div>

              {alert.type === 'block_rate_low' && alert.enabled && (
                <div className="flex items-center gap-3">
                  <Label className="text-xs text-muted-foreground whitespace-nowrap">Threshold (%)</Label>
                  <ThresholdInput
                    value={alert.threshold ?? 5}
                    disabled={saving === alert.id}
                    onCommit={(v) => updateAlert(alert, { threshold: v })}
                  />
                  <span className="text-xs text-muted-foreground">Alert when block rate drops below this value</span>
                </div>
              )}

              {alert.enabled && (
                <div className="space-y-3 border-t border-border/50 pt-3">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <p className="text-xs font-medium">Also push to channels</p>
                      <p className="text-[11px] text-muted-foreground mt-0.5">Send this alert to Gotify/email/etc. in addition to the in-app centre</p>
                    </div>
                    <Switch
                      checked={alert.pushEnabled}
                      onCheckedChange={(v) => updateAlert(alert, { pushEnabled: v })}
                      disabled={saving === alert.id}
                      aria-label={`${meta.title}: push notifications`}
                    />
                  </div>

                  {alert.pushEnabled && (
                    <>
                      <div className="flex items-center gap-3">
                        <Label className="text-xs text-muted-foreground whitespace-nowrap">Push when severity ≥</Label>
                        <select
                          value={alert.minPushSeverity}
                          onChange={(e) => updateAlert(alert, { minPushSeverity: e.target.value as AlertSetting['minPushSeverity'] })}
                          className="h-8 rounded-lg bg-background border border-border text-foreground text-sm px-2"
                        >
                          <option value="info">Info</option>
                          <option value="warning">Warning</option>
                          <option value="critical">Critical</option>
                        </select>
                      </div>

                      {channels.length === 0 ? (
                        <p className="text-[11px] text-warning/80">Add a channel under Notifications to enable push.</p>
                      ) : (
                        <div>
                          <p className="text-xs text-muted-foreground mb-2">Deliver via:</p>
                          <div className="flex flex-wrap gap-2">
                            {channels.map((ch) => {
                              const active = channelIds.includes(ch.id)
                              return (
                                <Button
                                  key={ch.id}
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => toggleChannel(alert, ch.id)}
                                  aria-pressed={active}
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
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/**
 * Threshold with a local draft, saved on blur/Enter. It used to PUT on every
 * keystroke: clearing the field sent NaN (-> null), which silently switched the
 * low-block-rate alert off, and fast typing could land requests out of order.
 */
function ThresholdInput({ value, disabled, onCommit }: { value: number; disabled: boolean; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => { setDraft(String(value)) }, [value])
  const commit = () => {
    const n = parseFloat(draft)
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      toast.error('Threshold must be a number from 0 to 100')
      setDraft(String(value))
      return
    }
    if (n !== value) onCommit(n)
  }
  return (
    <Input
      type="number"
      min={0}
      max={100}
      value={draft}
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
      className="w-24 bg-foreground/5 border-border h-8 text-sm"
    />
  )
}
