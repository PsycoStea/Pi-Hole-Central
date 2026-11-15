'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import SshHostKeysPanel from '@/components/dashboard/SshHostKeysPanel'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Plus, Trash2, Pencil, CheckCircle, XCircle, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { api, errorText } from '@/lib/client/api'
import PageHeader from '@/components/dashboard/PageHeader'

interface Instance {
  id: string
  name: string
  url: string
  enabled: boolean
  sshUsername?: string | null
}

function InstanceForm({
  initial,
  onSave,
  onCancel,
}: {
  initial?: Instance
  onSave: () => void
  onCancel: () => void
}) {
  const [name, setName] = useState(initial?.name ?? '')
  const [url, setUrl] = useState(initial?.url ?? '')
  const [password, setPassword] = useState('')
  const [sshUsername, setSshUsername] = useState(initial?.sshUsername ?? '')
  const [sshPassword, setSshPassword] = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [saving, setSaving] = useState(false)

  async function testConnection() {
    if (!url || !password) return toast.error('URL and password required to test')
    setTesting(true)
    setTestResult(null)
    try {
      const res = await fetch('/api/pihole/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, password }),
      })
      const data = await res.json().catch(() => ({}))
      setTestResult({
        ok: res.ok && !!data.ok,
        message: res.ok && data.ok ? `${data.queries} queries today` : (data.error ?? `HTTP ${res.status}`),
      })
    } catch {
      setTestResult({ ok: false, message: 'Network error' })
    } finally {
      setTesting(false)
    }
  }

  async function handleSave() {
    if (!name || !url) return toast.error('Name and URL are required')
    if (!initial && !password) return toast.error('Password is required for new instances')
    if (initial && url.replace(/\/$/, '') !== initial.url && !password) {
      return toast.error('Re-enter the Pi-hole password when changing the URL')
    }
    setSaving(true)
    try {
      const body: Record<string, unknown> = { name, url }
      if (password) body.password = password
      body.sshUsername = sshUsername || null
      if (sshPassword) body.sshPassword = sshPassword
      const res = await fetch(
        initial ? `/api/instances/${initial.id}` : '/api/instances',
        {
          method: initial ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      )
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error ?? 'Save failed')
      }
      const saved = await res.json().catch(() => ({}))
      toast.success(initial ? 'Instance updated' : 'Instance added')
      if (saved.sshPasswordCleared) {
        toast.warning('The host changed, so the stored SSH password was cleared. Enter it again if this node uses one.')
      }
      onSave()
    } catch (err) {
      toast.error(`Failed to save instance: ${(err as Error).message}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>Name</Label>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Home Pi-Hole"
          className="bg-foreground/5 border-border"
        />
      </div>
      <div className="space-y-2">
        <Label>URL</Label>
        <Input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="http://192.168.1.100"
          className="bg-foreground/5 border-border"
        />
      </div>
      <div className="space-y-2">
        <Label>{initial ? 'New Password (leave blank to keep current)' : 'Password'}</Label>
        <Input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••"
          className="bg-foreground/5 border-border"
        />
      </div>

      <div className="border-t border-border pt-4 space-y-4">
        <div>
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">
            SSH Recovery (optional)
          </p>
          <p className="text-xs text-muted-foreground">
            When Pi-Hole is unreachable, Pi-Hole Central will SSH in and attempt to restart
            pihole-FTL automatically. Requires passwordless sudo on the device. Leave blank to
            disable.
          </p>
        </div>
        <div className="space-y-2">
          <Label>SSH Username</Label>
          <Input
            value={sshUsername ?? ''}
            onChange={(e) => setSshUsername(e.target.value)}
            placeholder="pi"
            className="bg-foreground/5 border-border"
          />
        </div>
        <div className="space-y-2">
          <Label>
            SSH Password{' '}
            <span className="text-muted-foreground font-normal text-xs">
              (leave blank to use SSH_KEY_PATH key)
            </span>
          </Label>
          <Input
            type="password"
            value={sshPassword}
            onChange={(e) => setSshPassword(e.target.value)}
            placeholder={initial?.sshUsername ? '(unchanged)' : '••••••••'}
            className="bg-foreground/5 border-border"
          />
        </div>
      </div>

      {testResult && (
        <div className={`flex items-center gap-2 text-sm p-3 rounded-lg ${testResult.ok ? 'bg-success/10 text-success' : 'bg-destructive/10 text-destructive'}`}>
          {testResult.ok ? <CheckCircle className="h-4 w-4 shrink-0" /> : <XCircle className="h-4 w-4 shrink-0" />}
          {testResult.message}
        </div>
      )}

      <div className="flex gap-2 pt-2">
        <Button
          variant="outline"
          size="sm"
          onClick={testConnection}
          disabled={testing}
          className="border-border text-foreground/70 gap-1.5"
        >
          {testing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Test Connection
        </Button>
        <div className="flex-1" />
        <Button variant="ghost" size="sm" onClick={onCancel} className="text-muted-foreground">
          Cancel
        </Button>
        <Button size="sm" onClick={handleSave} disabled={saving}>
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />}
          {initial ? 'Update' : 'Add Instance'}
        </Button>
      </div>
    </div>
  )
}

export default function InstancesSettingsPage() {
  const [instances, setInstances] = useState<Instance[]>([])
  const [editingId, setEditingId] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)

  const fetchInstances = useCallback(async () => {
    const res = await fetch('/api/instances')
    if (res.ok) setInstances(await res.json())
  }, [])

  useEffect(() => { fetchInstances() }, [fetchInstances])

  async function deleteInstance(id: string) {
    if (!confirm('Delete this instance? This will also remove its historical data.')) return
    try {
      await api(`/api/instances/${id}`, { method: 'DELETE' })
      toast.success('Instance removed')
    } catch (err) {
      toast.error(errorText(err, 'Delete failed'))
    }
    fetchInstances()
  }

  async function toggleEnabled(id: string, enabled: boolean) {
    try {
      await api(`/api/instances/${id}`, { method: 'PUT', json: { enabled } })
    } catch (err) {
      toast.error(errorText(err, `Could not ${enabled ? 'enable' : 'disable'} instance`))
    }
    fetchInstances()
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <PageHeader
        title="Instances"
        description="Manage your Pi-Hole connections"
        actions={
          <>
            <Dialog open={addOpen} onOpenChange={setAddOpen}>
          <DialogTrigger render={
            <Button className="gap-1.5">
              <Plus className="h-4 w-4" />
              Add Instance
            </Button>
          } />
          <DialogContent >
            <DialogHeader>
              <DialogTitle>Add Pi-Hole Instance</DialogTitle>
            </DialogHeader>
            <InstanceForm
              onSave={() => { setAddOpen(false); fetchInstances() }}
              onCancel={() => setAddOpen(false)}
            />
          </DialogContent>
        </Dialog>
          </>
        }
      />

      <div className="space-y-3">
        {instances.length === 0 && (
          <div className="surface p-8 text-center text-muted-foreground text-sm">
            No instances added yet
          </div>
        )}
        {instances.map((inst) => (
          <div key={inst.id} className="surface p-4">
            {editingId === inst.id ? (
              <InstanceForm
                initial={inst}
                onSave={() => { setEditingId(null); fetchInstances() }}
                onCancel={() => setEditingId(null)}
              />
            ) : (
              <div className="flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <Link
                    href={`/instances/${inst.id}`}
                    title={inst.name}
                    className="line-clamp-2 break-words font-medium text-sm hover:text-primary transition-colors"
                  >
                    {inst.name}
                  </Link>
                  <p className="text-xs text-muted-foreground truncate">{inst.url}</p>
                </div>
                <Badge className={inst.enabled ? 'bg-success/10 text-success border-success/20' : 'bg-foreground/5 text-muted-foreground border-border'}>
                  {inst.enabled ? 'Enabled' : 'Disabled'}
                </Badge>
                <Switch
                  checked={inst.enabled}
                  onCheckedChange={(v) => toggleEnabled(inst.id, v)}
                  className="scale-90"
                  aria-label={`Instance enabled: ${inst.name}`}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-muted-foreground hover:text-foreground"
                  onClick={() => setEditingId(inst.id)}
                  aria-label={`Edit ${inst.name}`}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-muted-foreground hover:text-destructive"
                  onClick={() => deleteInstance(inst.id)}
                  aria-label={`Delete ${inst.name}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>

      <SshHostKeysPanel
        hostNames={Object.fromEntries(instances.flatMap((i) => {
          try { return [[new URL(i.url).hostname, i.name]] } catch { return [] }
        }))}
      />
    </div>
  )
}
