'use client'

import { useState } from 'react'
import { toast } from 'sonner'

export default function AccountPage() {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [saving, setSaving] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (next !== confirm) {
      toast.error('New passwords do not match')
      return
    }
    if (next.length < 8) {
      toast.error('New password must be at least 8 characters')
      return
    }
    setSaving(true)
    try {
      const res = await fetch('/api/users/me/password', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed')
      toast.success('Password changed successfully')
      setCurrent('')
      setNext('')
      setConfirm('')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to change password')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold gradient-text">Account</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Manage your account credentials</p>
      </div>

      <div className="glass-card p-6 space-y-5 max-w-md">
        <div>
          <h2 className="text-sm font-semibold">Change Password</h2>
          <p className="text-xs text-muted-foreground mt-0.5">You will remain logged in after changing your password.</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Current Password</label>
            <input
              type="password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              required
              className="w-full px-3 py-2 rounded-lg bg-black/20 border border-border text-sm placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-blue-500/50"
              placeholder="••••••••"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">New Password</label>
            <input
              type="password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              required
              minLength={8}
              className="w-full px-3 py-2 rounded-lg bg-black/20 border border-border text-sm placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-blue-500/50"
              placeholder="Min. 8 characters"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Confirm New Password</label>
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              className="w-full px-3 py-2 rounded-lg bg-black/20 border border-border text-sm placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-blue-500/50"
              placeholder="••••••••"
            />
          </div>

          <button
            type="submit"
            disabled={saving || !current || !next || !confirm}
            className="w-full px-4 py-2 rounded-lg text-sm font-medium bg-gradient-to-r from-blue-600 to-blue-500 text-white hover:from-blue-500 hover:to-blue-400 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
          >
            {saving ? 'Saving…' : 'Change Password'}
          </button>
        </form>
      </div>
    </div>
  )
}
