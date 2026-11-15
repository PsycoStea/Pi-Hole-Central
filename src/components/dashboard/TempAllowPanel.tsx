'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { toast } from 'sonner'
import { api, errorText } from '@/lib/client/api'
import { Timer, X } from 'lucide-react'

interface Instance { id: string; name: string }
interface TempAllow {
  id: string
  instanceId: string
  domain: string
  kind: string
  list: string
  expiresAt: string
}

const DURATIONS = [
  { label: '5 min', value: 5 },
  { label: '15 min', value: 15 },
  { label: '30 min', value: 30 },
  { label: '1 hour', value: 60 },
  { label: '3 hours', value: 180 },
]

function remaining(expiresAt: string): string {
  const ms = new Date(expiresAt).getTime() - Date.now()
  if (ms <= 0) return 'expiring…'
  const m = Math.floor(ms / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

export default function TempAllowPanel({
  instances,
  selectedInstance,
}: {
  instances: Instance[]
  selectedInstance: string
}) {
  const isAll = selectedInstance === '__all__'
  const targets = isAll ? instances.map((i) => i.id) : [selectedInstance].filter(Boolean)

  const [domain, setDomain] = useState('')
  const [list, setList] = useState<'allow' | 'deny'>('allow')
  const [duration, setDuration] = useState(15)
  const [items, setItems] = useState<TempAllow[]>([])
  const [busy, setBusy] = useState(false)
  const [, setTick] = useState(0)

  const fetchActive = useCallback(async () => {
    if (!targets.length) return
    try {
      const results = await Promise.all(
        targets.map((id) => fetch(`/api/pihole/${id}/temp-allow`).then((r) => (r.ok ? r.json() : { tempAllows: [] })))
      )
      setItems(results.flatMap((r) => r.tempAllows ?? []))
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedInstance, instances.length])

  useEffect(() => { fetchActive() }, [fetchActive])
  // live countdown
  useEffect(() => {
    if (!items.length) return
    const id = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(id)
  }, [items.length])

  const add = async () => {
    if (!domain.trim() || !targets.length) return
    setBusy(true)
    try {
      const results = await Promise.allSettled(
        targets.map((id) =>
          fetch(`/api/pihole/${id}/temp-allow`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ domain: domain.trim(), list, durationMinutes: duration }),
          }).then(async (r) => {
            if (!r.ok) {
              const d = await r.json().catch(() => ({}))
              throw new Error(d.error ?? `HTTP ${r.status}`)
            }
          })
        )
      )
      const ok = results.filter((r) => r.status === 'fulfilled').length
      // Show WHY a node refused (e.g. 409: already permanently on the list),
      // and don't report a partial failure as plain success.
      const failed = results
        .map((r, i) => (r.status === 'rejected' ? `${instName(targets[i])}: ${(r.reason as Error).message}` : null))
        .filter(Boolean)
      if (ok) toast.success(`Temporary ${list} added on ${ok} node${ok !== 1 ? 's' : ''} for ${duration}m`)
      if (failed.length) toast.error(`Not added — ${failed.join('; ')}`)
      setDomain('')
      fetchActive()
    } finally {
      setBusy(false)
    }
  }

  const revert = async (t: TempAllow) => {
    try {
      await api(`/api/pihole/${t.instanceId}/temp-allow`, { method: 'DELETE', json: { id: t.id } })
      toast.success(`Removed the temporary entry for ${t.domain} on ${instName(t.instanceId)}`)
    } catch (err) {
      toast.error(`Could not end the temporary allow: ${errorText(err)}`)
    }
    fetchActive()
  }

  const instName = (id: string) => instances.find((i) => i.id === id)?.name ?? id

  return (
    <div className="surface p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Timer className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">Temporary rule</span>
        <span className="text-xs text-muted-foreground">auto-reverts when it expires</span>
      </div>
      <div className="flex items-end gap-2 flex-wrap">
        <div className="flex-1 min-w-[12rem]">
          <Label className="text-xs text-muted-foreground">Domain</Label>
          <Input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="example.com"
            className="bg-foreground/5 border-border" />
        </div>
        <div>
          <Label className="text-xs text-muted-foreground">List</Label>
          <select value={list} onChange={(e) => setList(e.target.value as 'allow' | 'deny')}
            className="block h-9 rounded-lg bg-background border border-border text-foreground text-sm px-2 mt-1">
            <option value="allow">Allow</option>
            <option value="deny">Deny</option>
          </select>
        </div>
        <div>
          <Label className="text-xs text-muted-foreground">For</Label>
          <select value={duration} onChange={(e) => setDuration(Number(e.target.value))}
            className="block h-9 rounded-lg bg-background border border-border text-foreground text-sm px-2 mt-1">
            {DURATIONS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
          </select>
        </div>
        <Button size="sm" onClick={add} disabled={busy || !domain.trim()}>
          Add
        </Button>
      </div>

      {items.length > 0 && (
        <div className="space-y-1.5 pt-1">
          {items.map((t) => (
            <div key={t.id} className="flex items-center gap-2 text-xs bg-foreground/5 rounded-lg px-3 py-2">
              <span className={`h-1.5 w-1.5 rounded-full ${t.list === 'allow' ? 'bg-success' : 'bg-destructive'}`} />
              <span className="font-mono flex-1 truncate">{t.domain}</span>
              {isAll && <span className="text-muted-foreground">{instName(t.instanceId)}</span>}
              <span className="text-muted-foreground tabular-nums">{remaining(t.expiresAt)}</span>
              <button onClick={() => revert(t)} aria-label="Revert now" className="text-muted-foreground hover:text-foreground">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
