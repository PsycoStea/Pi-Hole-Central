'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { toast } from 'sonner'
import { api, errorText } from '@/lib/client/api'
import { Download, Trash2, Upload, Save, DatabaseBackup } from 'lucide-react'
import PageHeader from '@/components/dashboard/PageHeader'

interface Instance { id: string; name: string }
interface BackupRow {
  id: string
  instanceId: string
  instanceName: string
  filename: string
  sizeBytes: number
  trigger: string
  success: boolean
  note: string
  createdAt: string
}
interface Settings {
  backupInterval: string
  backupRetentionCount: number
  backupWebhookUrl: string
  backupWebhookTokenSet: boolean
}

function fmtSize(b: number): string {
  if (b <= 0) return '—'
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${(b / 1024 / 1024).toFixed(1)} MB`
}

export default function BackupsPage() {
  const [rows, setRows] = useState<BackupRow[]>([])
  const [instances, setInstances] = useState<Instance[]>([])
  const [settings, setSettings] = useState<Settings | null>(null)
  const [webhookInput, setWebhookInput] = useState('')
  // Draft for "Keep last". It used to be an uncontrolled defaultValue that
  // rendered (as 14) before settings loaded and saved on blur, so tabbing
  // through it could quietly change retention — and the next backup pruned.
  const [keepDraft, setKeepDraft] = useState('')
  const [tokenInput, setTokenInput] = useState('')
  const [running, setRunning] = useState(false)
  const [restoreTarget, setRestoreTarget] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const fetchAll = useCallback(async () => {
    const [bRes, iRes, sRes] = await Promise.all([
      fetch('/api/backups'),
      // Only ids/names are needed: /api/instances makes no node calls (P5.8).
      fetch('/api/instances'),
      fetch('/api/settings'),
    ])
    if (bRes.ok) setRows(await bRes.json())
    if (iRes.ok) {
      const rows: (Instance & { enabled?: boolean })[] = await iRes.json()
      const insts = (Array.isArray(rows) ? rows : []).filter((i) => i.enabled).map((i) => ({ id: i.id, name: i.name }))
      setInstances(insts)
      if (insts[0]) setRestoreTarget((prev) => prev || insts[0].id)
    }
    if (sRes.ok) {
      const s = await sRes.json()
      setSettings(s)
      setWebhookInput(s.backupWebhookUrl ?? '')
      setKeepDraft(String(s.backupRetentionCount ?? ''))
    }
  }, [])

  useEffect(() => { fetchAll() }, [fetchAll])

  const saveSetting = async (patch: Record<string, unknown>, msg: string) => {
    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
    if (res.ok) { toast.success(msg); fetchAll() }
    else toast.error((await res.json()).error ?? 'Save failed')
  }

  const backupNow = async () => {
    setRunning(true)
    const t = toast.loading('Backing up all instances…')
    try {
      const res = await fetch('/api/backups', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ all: true }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { toast.error(d.error ?? `Backup failed (HTTP ${res.status})`, { id: t }); return }
      const ok = (d.results ?? []).filter((r: { ok: boolean }) => r.ok).length
      const fail = (d.results ?? []).length - ok
      if (fail === 0) toast.success(`Backed up ${ok} instance(s)`, { id: t })
      else toast.error(`${ok} ok, ${fail} failed`, { id: t })
      fetchAll()
    } catch {
      toast.error('Backup request failed', { id: t })
    } finally {
      setRunning(false)
    }
  }

  const del = async (r: BackupRow) => {
    if (!confirm('Delete this backup?')) return
    try {
      await api(`/api/backups/${r.id}`, { method: 'DELETE' })
      toast.success('Backup deleted')
    } catch (err) {
      toast.error(errorText(err, 'Delete failed'))
    }
    fetchAll()
  }

  const restore = async () => {
    const f = fileRef.current?.files?.[0]
    if (!f || !restoreTarget) { toast.error('Choose an instance and a .zip file'); return }
    const inst = instances.find((i) => i.id === restoreTarget)
    if (!confirm(`Restore "${f.name}" into ${inst?.name}? This OVERWRITES that node's current configuration.`)) return
    const t = toast.loading('Restoring…')
    try {
      const form = new FormData()
      form.append('file', f)
      const res = await fetch(`/api/pihole/${restoreTarget}/restore`, { method: 'POST', body: form })
      if (!res.ok) throw new Error((await res.json()).error ?? 'Restore failed')
      toast.success('Restore complete', { id: t })
      if (fileRef.current) fileRef.current.value = ''
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Restore failed', { id: t })
    }
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <PageHeader
        title="Backups"
        description="Teleporter config backups — scheduled or on demand."
        actions={
          <>
            <Button onClick={backupNow} disabled={running} className="gap-1.5">
          <DatabaseBackup className="h-4 w-4" /> {running ? 'Backing up…' : 'Backup now'}
        </Button>
          </>
        }
      />

      {/* Config */}
      <div className="surface p-5 space-y-4">
        <div className="flex flex-wrap gap-6">
          <div>
            <Label className="text-xs text-muted-foreground">Schedule</Label>
            <select value={settings?.backupInterval ?? 'off'}
              onChange={(e) => saveSetting({ backupInterval: e.target.value }, 'Schedule updated')}
              className="block h-9 rounded-lg bg-background border border-border text-foreground text-sm px-2 mt-1">
              <option value="off">Off</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
            </select>
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">Keep last</Label>
            <Input type="number" min={1} max={100} value={keepDraft} disabled={!settings}
              onChange={(e) => setKeepDraft(e.target.value)}
              onBlur={() => {
                const n = parseInt(keepDraft, 10)
                if (!settings || n === settings.backupRetentionCount) return // unchanged: don't save
                if (!Number.isInteger(n) || n < 1 || n > 100) {
                  toast.error('Keep last must be 1-100')
                  setKeepDraft(String(settings.backupRetentionCount))
                  return
                }
                if (n < settings.backupRetentionCount &&
                    !confirm(`Keep only the last ${n} backups per node? Older backups beyond ${n} will be deleted on the next backup.`)) {
                  setKeepDraft(String(settings.backupRetentionCount))
                  return
                }
                saveSetting({ backupRetentionCount: n }, 'Retention updated')
              }}
              className="w-24 bg-foreground/5 border-border h-9 mt-1" />
          </div>
        </div>

        <div>
          <Label className="text-xs text-muted-foreground">n8n webhook URL (optional)</Label>
          <div className="flex gap-2 mt-1">
            <Input value={webhookInput} onChange={(e) => setWebhookInput(e.target.value)}
              placeholder="https://n8n.local/webhook/…" className="bg-foreground/5 border-border" />
            <Button size="sm" variant="outline" onClick={() => {
              // A typed token goes with the URL; without one the server clears the old token on a URL change.
              const tok = tokenInput.trim()
              saveSetting({ backupWebhookUrl: webhookInput, ...(tok ? { backupWebhookToken: tok } : {}) }, 'Webhook saved')
              if (tok) setTokenInput('')
            }} className="gap-1.5">
              <Save className="h-3.5 w-3.5" /> Save
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground mt-1">
            POSTed after each backup with the instance, filename, size and success. Changing the URL clears the saved
            token: type it in the token field first and it is saved together with the URL.
          </p>
        </div>

        <div>
          <Label className="text-xs text-muted-foreground">
            Webhook token (optional{settings?.backupWebhookTokenSet ? ' — set' : ''})
          </Label>
          <div className="flex gap-2 mt-1">
            <Input type="password" value={tokenInput} onChange={(e) => setTokenInput(e.target.value)}
              placeholder={settings?.backupWebhookTokenSet ? '•••••• (leave blank to keep)' : 'sent as X-Webhook-Token'}
              className="bg-foreground/5 border-border" />
            <Button size="sm" variant="outline" disabled={!tokenInput.trim()}
              onClick={() => { saveSetting({ backupWebhookToken: tokenInput }, 'Token saved'); setTokenInput('') }}>Save</Button>
            {settings?.backupWebhookTokenSet && (
              <Button size="sm" variant="outline" className="text-destructive"
                onClick={() => saveSetting({ backupWebhookTokenClear: true }, 'Token cleared')}>Clear</Button>
            )}
          </div>
        </div>
      </div>

      {/* Restore */}
      <div className="surface p-5 space-y-3">
        <div className="flex items-center gap-2">
          <Upload className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">Restore from a .zip</span>
          <span className="text-xs text-destructive/80">overwrites the target node's config</span>
        </div>
        <div className="flex items-end gap-2 flex-wrap">
          <div>
            <Label className="text-xs text-muted-foreground">Target</Label>
            <select value={restoreTarget} onChange={(e) => setRestoreTarget(e.target.value)}
              className="block h-9 rounded-lg bg-background border border-border text-foreground text-sm px-2 mt-1">
              {instances.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
            </select>
          </div>
          <input ref={fileRef} type="file" accept=".zip" className="text-xs text-muted-foreground" />
          <Button size="sm" variant="outline" onClick={restore} className="text-destructive">Restore</Button>
        </div>
      </div>

      {/* History */}
      <div>
        <h2 className="text-sm font-medium mb-2">History</h2>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] text-sm">
            <thead>
              <tr className="text-muted-foreground text-left border-b border-border">
                <th className="py-2 font-medium">When</th>
                <th className="py-2 font-medium">Instance</th>
                <th className="py-2 font-medium">Size</th>
                <th className="py-2 font-medium">Trigger</th>
                <th className="py-2 font-medium"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {rows.length === 0 ? (
                <tr><td colSpan={5} className="py-8 text-center text-muted-foreground">No backups yet</td></tr>
              ) : rows.map((r) => (
                <tr key={r.id}>
                  <td className="py-2">
                    <span className={`inline-block h-1.5 w-1.5 rounded-full mr-2 ${r.success ? 'bg-success' : 'bg-destructive'}`} />
                    {new Date(r.createdAt).toLocaleString()}
                  </td>
                  <td className="py-2">{r.instanceName}</td>
                  <td className="py-2 text-muted-foreground">{r.success ? fmtSize(r.sizeBytes) : <span className="text-destructive" title={r.note}>failed</span>}</td>
                  <td className="py-2 text-muted-foreground capitalize">{r.trigger}</td>
                  <td className="py-2 text-right">
                    {r.success && r.filename && (
                      <a href={`/api/backups/${r.id}/download`} className="inline-flex items-center text-muted-foreground hover:text-foreground mr-3" aria-label="Download">
                        <Download className="h-4 w-4" />
                      </a>
                    )}
                    <button onClick={() => del(r)} className="text-muted-foreground hover:text-foreground" aria-label="Delete">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
