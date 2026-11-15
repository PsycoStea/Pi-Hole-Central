'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

import PageHeader from '@/components/dashboard/PageHeader'

interface AuditEntry {
  id: string
  timestamp: string
  userId: string
  username: string
  action: string
  target: string
  detail: string
  ip: string
}

const PAGE = 50

export default function AuditPage() {
  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [actions, setActions] = useState<string[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [action, setAction] = useState('')
  const [user, setUser] = useState('')
  const [loading, setLoading] = useState(true)

  const fetchPage = useCallback(
    async (reset: boolean) => {
      setLoading(true)
      const params = new URLSearchParams()
      params.set('limit', String(PAGE))
      params.set('offset', String(reset ? 0 : offset))
      if (action) params.set('action', action)
      if (user) params.set('user', user)
      try {
        const r = await fetch(`/api/audit?${params}`)
        if (r.ok) {
          const d = await r.json()
          setEntries((prev) => (reset ? d.entries : [...prev, ...d.entries]))
          setTotal(d.total ?? 0)
          setActions(d.actions ?? [])
          setOffset((reset ? 0 : offset) + (d.entries?.length ?? 0))
        }
      } finally {
        setLoading(false)
      }
    },
    [offset, action, user]
  )

  useEffect(() => {
    const t = setTimeout(() => fetchPage(true), 250) // debounce the username filter
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action, user])

  return (
    <div className="space-y-6">
      <PageHeader title="Audit Log" description="Record of configuration changes made through the dashboard." />

      <div className="flex items-center gap-2 flex-wrap">
        <select value={action} onChange={(e) => setAction(e.target.value)}
          className="h-9 rounded-lg bg-background border border-border text-foreground text-sm px-3">
          <option value="">All actions</option>
          {actions.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
        <Input value={user} onChange={(e) => setUser(e.target.value)} placeholder="Filter by user…"
          className="bg-foreground/5 border-border h-9 w-48" />
        <span className="text-xs text-muted-foreground ml-auto">{total} entries</span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[40rem] text-sm">
          <thead>
            <tr className="text-muted-foreground text-left border-b border-border">
              <th className="py-2 font-medium">When</th>
              <th className="py-2 font-medium">User</th>
              <th className="py-2 font-medium">Action</th>
              <th className="py-2 font-medium">Target</th>
              <th className="py-2 font-medium">Detail</th>
              <th className="py-2 font-medium">IP</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {entries.length === 0 && !loading ? (
              <tr><td colSpan={6} className="py-8 text-center text-muted-foreground">No audit entries</td></tr>
            ) : entries.map((e) => (
              <tr key={e.id}>
                <td className="py-2 whitespace-nowrap text-muted-foreground">{new Date(e.timestamp).toLocaleString()}</td>
                <td className="py-2">{e.username}</td>
                <td className="py-2 font-mono text-xs">{e.action}</td>
                <td className="py-2 font-mono text-xs text-muted-foreground max-w-[12rem] truncate" title={e.target}>{e.target || '—'}</td>
                <td className="py-2 text-muted-foreground max-w-[14rem] truncate" title={e.detail}>{e.detail || '—'}</td>
                <td className="py-2 text-muted-foreground text-xs">{e.ip || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {entries.length < total && (
        <div className="flex justify-center">
          <Button variant="outline" size="sm" onClick={() => fetchPage(false)} disabled={loading}>
            {loading ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}
    </div>
  )
}
