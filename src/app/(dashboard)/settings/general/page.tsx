'use client'

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { api, errorText } from '@/lib/client/api'
import PageHeader from '@/components/dashboard/PageHeader'

const RETENTION_OPTIONS = [
  { value: 1, label: '1 day' },
  { value: 7, label: '7 days' },
  { value: 14, label: '14 days' },
  { value: 30, label: '30 days' },
]

const POLL_OPTIONS = [
  { value: 60, label: '1 minute' },
  { value: 120, label: '2 minutes' },
  { value: 300, label: '5 minutes' },
  { value: 600, label: '10 minutes' },
]

const STATS_OPTIONS = [
  { value: 120, label: '2 minutes' },
  { value: 300, label: '5 minutes' },
  { value: 600, label: '10 minutes' },
  { value: 1800, label: '30 minutes' },
]

const AUDIT_RETENTION_OPTIONS = [
  { value: 30, label: '30 days' },
  { value: 90, label: '90 days' },
  { value: 180, label: '180 days' },
  { value: 365, label: '1 year' },
]

const UPDATE_CHECK_OPTIONS = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
]

export default function GeneralSettingsPage() {
  const [retentionDays, setRetentionDays] = useState<number | null>(null)
  const [auditRetentionDays, setAuditRetentionDays] = useState<number | null>(null)
  const [pollIntervalSeconds, setPollIntervalSeconds] = useState<number | null>(null)
  const [statsIntervalSeconds, setStatsIntervalSeconds] = useState<number | null>(null)
  const [updateCheckInterval, setUpdateCheckInterval] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // Load (and, after a failed save, reload) what the server actually has, so
  // the controls never show a value that wasn't saved.
  const load = useCallback(async () => {
    try {
      const d = await api<{ retentionDays: number; auditRetentionDays: number; pollIntervalSeconds: number; statsIntervalSeconds: number; updateCheckInterval?: string }>('/api/settings')
      setRetentionDays(d.retentionDays)
      setAuditRetentionDays(d.auditRetentionDays)
      setPollIntervalSeconds(d.pollIntervalSeconds)
      setStatsIntervalSeconds(d.statsIntervalSeconds)
      setUpdateCheckInterval(d.updateCheckInterval ?? 'daily')
    } catch (err) {
      toast.error(errorText(err, 'Failed to load settings'))
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function save(patch: Record<string, unknown>, label: string) {
    setSaving(true)
    try {
      await api('/api/settings', { method: 'PUT', json: patch })
      toast.success(`${label} saved`)
    } catch (err) {
      toast.error(`Failed to save ${label.toLowerCase()}: ${errorText(err)}`)
      await load()
    } finally {
      setSaving(false)
    }
  }

  function handleRetentionChange(days: number) {
    setRetentionDays(days)
    return save({ retentionDays: days }, 'Retention')
  }

  function handleAuditRetentionChange(days: number) {
    setAuditRetentionDays(days)
    return save({ auditRetentionDays: days }, 'Audit log retention')
  }

  function handlePollChange(seconds: number) {
    setPollIntervalSeconds(seconds)
    return save({ pollIntervalSeconds: seconds }, 'Poll interval')
  }

  function handleStatsChange(seconds: number) {
    setStatsIntervalSeconds(seconds)
    return save({ statsIntervalSeconds: seconds }, 'Stats interval')
  }

  function handleUpdateCheckChange(interval: string) {
    setUpdateCheckInterval(interval)
    return save({ updateCheckInterval: interval }, 'Update check interval')
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <PageHeader title="General Settings" description="Application-wide configuration" />

      <div className="surface p-6 space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Data Retention</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            How long to keep historical query snapshots. Older data is pruned automatically.
          </p>
        </div>

        <div className="flex flex-wrap gap-3">
          {RETENTION_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => handleRetentionChange(opt.value)}
              disabled={saving}
              className={[
                'px-4 py-2 rounded-lg text-sm font-medium border transition-colors',
                retentionDays === opt.value
                  ? 'bg-primary/20 border-primary/50 text-primary'
                  : 'bg-foreground/5 border-border text-foreground/60 hover:text-foreground hover:bg-foreground/10',
              ].join(' ')}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div className="surface p-6 space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Audit Log Retention</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            How long to keep the record of who changed what. Kept separately from query data and never
            less than 30 days.
          </p>
        </div>

        <div className="flex flex-wrap gap-3">
          {AUDIT_RETENTION_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => handleAuditRetentionChange(opt.value)}
              disabled={saving}
              className={[
                'px-4 py-2 rounded-lg text-sm font-medium border transition-colors',
                auditRetentionDays === opt.value
                  ? 'bg-primary/20 border-primary/50 text-primary'
                  : 'bg-foreground/5 border-border text-foreground/60 hover:text-foreground hover:bg-foreground/10',
              ].join(' ')}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div className="surface p-6 space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Poll Interval</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            How often to check Pi-Hole health and record stats. Drives online/offline detection and
            SSH recovery. Changes take effect on the next scheduled check.
          </p>
        </div>

        <div className="flex flex-wrap gap-3">
          {POLL_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => handlePollChange(opt.value)}
              disabled={saving}
              className={[
                'px-4 py-2 rounded-lg text-sm font-medium border transition-colors',
                pollIntervalSeconds === opt.value
                  ? 'bg-primary/20 border-primary/50 text-primary'
                  : 'bg-foreground/5 border-border text-foreground/60 hover:text-foreground hover:bg-foreground/10',
              ].join(' ')}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div className="surface p-6 space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Stats Interval</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            How often to fetch top domains and clients from your Pi-Hole devices. Health checks run
            independently at the poll interval above. Longer values reduce requests to your Pi devices.
          </p>
        </div>

        <div className="flex flex-wrap gap-3">
          {STATS_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => handleStatsChange(opt.value)}
              disabled={saving}
              className={[
                'px-4 py-2 rounded-lg text-sm font-medium border transition-colors',
                statsIntervalSeconds === opt.value
                  ? 'bg-primary/20 border-primary/50 text-primary'
                  : 'bg-foreground/5 border-border text-foreground/60 hover:text-foreground hover:bg-foreground/10',
              ].join(' ')}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div className="surface p-6 space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Update Checks</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            How often to check if a Pi-Hole software update is available. A toast notification appears
            on the dashboard when an update is detected.
          </p>
        </div>

        <div className="flex flex-wrap gap-3">
          {UPDATE_CHECK_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => handleUpdateCheckChange(opt.value)}
              disabled={saving}
              className={[
                'px-4 py-2 rounded-lg text-sm font-medium border transition-colors',
                updateCheckInterval === opt.value
                  ? 'bg-primary/20 border-primary/50 text-primary'
                  : 'bg-foreground/5 border-border text-foreground/60 hover:text-foreground hover:bg-foreground/10',
              ].join(' ')}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
