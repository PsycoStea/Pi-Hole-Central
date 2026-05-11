'use client'

import { useEffect, useState, useCallback } from 'react'
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

interface Instance {
  id: string
  name: string
  url: string
  enabled: boolean
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
      const data = await res.json()
      setTestResult({ ok: data.ok, message: data.ok ? `${data.queries} queries today` : data.error })
    } catch {
      setTestResult({ ok: false, message: 'Network error' })
    } finally {
      setTesting(false)
    }
  }

  async function handleSave() {
    if (!name || !url) return toast.error('Name and URL are required')
    if (!initial && !password) return toast.error('Password is required for new instances')
    setSaving(true)
    try {
      const body: Record<string, unknown> = { name, url }
      if (password) body.password = password
      const res = await fetch(
        initial ? `/api/instances/${initial.id}` : '/api/instances',
        {
          method: initial ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      )
      if (!res.ok) throw new Error('Save failed')
      toast.success(initial ? 'Instance updated' : 'Instance added')
      onSave()
    } catch {
      toast.error('Failed to save instance')
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
          className="bg-white/5 border-white/10"
        />
      </div>
      <div className="space-y-2">
        <Label>URL</Label>
        <Input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="http://192.168.1.100"
          className="bg-white/5 border-white/10"
        />
      </div>
      <div className="space-y-2">
        <Label>{initial ? 'New Password (leave blank to keep current)' : 'Password'}</Label>
        <Input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••"
          className="bg-white/5 border-white/10"
        />
      </div>

      {testResult && (
        <div className={`flex items-center gap-2 text-sm p-3 rounded-lg ${testResult.ok ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'}`}>
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
          className="border-white/10 text-white/70 gap-1.5"
        >
          {testing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Test Connection
        </Button>
        <div className="flex-1" />
        <Button variant="ghost" size="sm" onClick={onCancel} className="text-white/50">
          Cancel
        </Button>
        <Button size="sm" onClick={handleSave} disabled={saving} className="bg-blue-600 hover:bg-blue-700">
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
    await fetch(`/api/instances/${id}`, { method: 'DELETE' })
    toast.success('Instance removed')
    fetchInstances()
  }

  async function toggleEnabled(id: string, enabled: boolean) {
    await fetch(`/api/instances/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    })
    fetchInstances()
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Instances</h1>
          <p className="text-sm text-white/40 mt-0.5">Manage your Pi-Hole connections</p>
        </div>
        <Dialog open={addOpen} onOpenChange={setAddOpen}>
          <DialogTrigger render={
            <Button size="sm" className="bg-blue-600 hover:bg-blue-700 gap-1.5">
              <Plus className="h-4 w-4" />
              Add Instance
            </Button>
          } />
          <DialogContent className="bg-zinc-900 border-white/10">
            <DialogHeader>
              <DialogTitle>Add Pi-Hole Instance</DialogTitle>
            </DialogHeader>
            <InstanceForm
              onSave={() => { setAddOpen(false); fetchInstances() }}
              onCancel={() => setAddOpen(false)}
            />
          </DialogContent>
        </Dialog>
      </div>

      <div className="space-y-3">
        {instances.length === 0 && (
          <div className="glass-card p-8 text-center text-white/30 text-sm">
            No instances added yet
          </div>
        )}
        {instances.map((inst) => (
          <div key={inst.id} className="glass-card p-4">
            {editingId === inst.id ? (
              <InstanceForm
                initial={inst}
                onSave={() => { setEditingId(null); fetchInstances() }}
                onCancel={() => setEditingId(null)}
              />
            ) : (
              <div className="flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm">{inst.name}</p>
                  <p className="text-xs text-white/40 truncate">{inst.url}</p>
                </div>
                <Badge className={inst.enabled ? 'bg-green-500/10 text-green-400 border-green-500/20' : 'bg-white/5 text-white/30 border-white/10'}>
                  {inst.enabled ? 'Enabled' : 'Disabled'}
                </Badge>
                <Switch
                  checked={inst.enabled}
                  onCheckedChange={(v) => toggleEnabled(inst.id, v)}
                  className="scale-90"
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-white/40 hover:text-white"
                  onClick={() => setEditingId(inst.id)}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-white/40 hover:text-red-400"
                  onClick={() => deleteInstance(inst.id)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
