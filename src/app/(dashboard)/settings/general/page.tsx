'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'

const RETENTION_OPTIONS = [
  { value: 1, label: '1 day' },
  { value: 7, label: '7 days' },
  { value: 14, label: '14 days' },
  { value: 30, label: '30 days' },
]

export default function GeneralSettingsPage() {
  const [retentionDays, setRetentionDays] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    fetch('/api/settings')
      .then((r) => r.json())
      .then((d) => setRetentionDays(d.retentionDays))
      .catch(() => toast.error('Failed to load settings'))
  }, [])

  async function handleChange(days: number) {
    setSaving(true)
    setRetentionDays(days)
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ retentionDays: days }),
      })
      if (!res.ok) throw new Error()
      toast.success('Settings saved')
    } catch {
      toast.error('Failed to save settings')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">General Settings</h1>
        <p className="text-sm text-white/40 mt-0.5">Application-wide configuration</p>
      </div>

      <div className="glass-card p-6 space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-white">Data Retention</h2>
          <p className="text-xs text-white/40 mt-0.5">
            How long to keep historical query snapshots. Older data is pruned automatically.
          </p>
        </div>

        <div className="flex flex-wrap gap-3">
          {RETENTION_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => handleChange(opt.value)}
              disabled={saving}
              className={[
                'px-4 py-2 rounded-lg text-sm font-medium border transition-colors',
                retentionDays === opt.value
                  ? 'bg-blue-500/20 border-blue-500/50 text-blue-300'
                  : 'bg-white/5 border-white/10 text-white/60 hover:text-white hover:bg-white/10',
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
