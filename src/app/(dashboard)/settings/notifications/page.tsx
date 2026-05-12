'use client'

import { useEffect, useState, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Plus, Trash2, Send, Loader2 } from 'lucide-react'
import { toast } from 'sonner'

interface Channel {
  id: string
  type: string
  label: string
  enabled: boolean
}

const PROVIDER_FIELDS: Record<string, { key: string; label: string; placeholder: string; type?: string }[]> = {
  gotify: [
    { key: 'url', label: 'Server URL', placeholder: 'http://gotify.example.com' },
    { key: 'token', label: 'App Token', placeholder: 'A...' },
    { key: 'priority', label: 'Priority (1-10)', placeholder: '5' },
  ],
  pushover: [
    { key: 'token', label: 'API Token', placeholder: 'a...' },
    { key: 'user', label: 'User Key', placeholder: 'u...' },
  ],
  telegram: [
    { key: 'token', label: 'Bot Token', placeholder: '123456:ABC...' },
    { key: 'chatId', label: 'Chat ID', placeholder: '-100...' },
  ],
  email: [
    { key: 'host', label: 'SMTP Host', placeholder: 'smtp.example.com' },
    { key: 'port', label: 'Port', placeholder: '587' },
    { key: 'user', label: 'Username', placeholder: 'user@example.com' },
    { key: 'pass', label: 'Password', placeholder: '••••••••', type: 'password' },
    { key: 'from', label: 'From', placeholder: 'pihole@example.com' },
    { key: 'to', label: 'To', placeholder: 'you@example.com' },
  ],
}

function AddChannelDialog({ onSave, onClose }: { onSave: () => void; onClose: () => void }) {
  const [type, setType] = useState('gotify')
  const [label, setLabel] = useState('')
  const [config, setConfig] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  const fields = PROVIDER_FIELDS[type] ?? []

  async function handleSave() {
    if (!label) return toast.error('Label is required')
    setSaving(true)
    try {
      const res = await fetch('/api/notifications/channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, label, config }),
      })
      if (!res.ok) throw new Error()
      toast.success('Notification channel added')
      onSave()
    } catch {
      toast.error('Failed to add channel')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>Provider</Label>
        <Select value={type} onValueChange={(v) => { setType(v ?? 'gotify'); setConfig({}) }}>
          <SelectTrigger className="bg-white/5 border-border">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="bg-zinc-900 border-border">
            {Object.keys(PROVIDER_FIELDS).map((p) => (
              <SelectItem key={p} value={p} className="capitalize">{p}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label>Label</Label>
        <Input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="My Gotify Server"
          className="bg-white/5 border-border"
        />
      </div>
      {fields.map((f) => (
        <div key={f.key} className="space-y-2">
          <Label>{f.label}</Label>
          <Input
            type={f.type ?? 'text'}
            value={config[f.key] ?? ''}
            onChange={(e) => setConfig((c) => ({ ...c, [f.key]: e.target.value }))}
            placeholder={f.placeholder}
            className="bg-white/5 border-border"
          />
        </div>
      ))}
      <div className="flex gap-2 pt-2">
        <div className="flex-1" />
        <Button variant="ghost" size="sm" onClick={onClose} className="text-muted-foreground">Cancel</Button>
        <Button size="sm" onClick={handleSave} disabled={saving} className="bg-blue-600 hover:bg-blue-700">
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />}
          Add Channel
        </Button>
      </div>
    </div>
  )
}

export default function NotificationsPage() {
  const [channels, setChannels] = useState<Channel[]>([])
  const [addOpen, setAddOpen] = useState(false)
  const [testingId, setTestingId] = useState<string | null>(null)

  const fetchChannels = useCallback(async () => {
    const res = await fetch('/api/notifications/channels')
    if (res.ok) setChannels(await res.json())
  }, [])

  useEffect(() => { fetchChannels() }, [fetchChannels])

  async function toggleChannel(id: string, enabled: boolean) {
    await fetch(`/api/notifications/channels/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    })
    fetchChannels()
  }

  async function deleteChannel(id: string) {
    if (!confirm('Delete this notification channel?')) return
    await fetch(`/api/notifications/channels/${id}`, { method: 'DELETE' })
    toast.success('Channel removed')
    fetchChannels()
  }

  async function sendTest(id: string) {
    setTestingId(id)
    try {
      const res = await fetch(`/api/notifications/channels/${id}/test`, { method: 'POST' })
      const data = await res.json()
      if (data.ok) toast.success('Test notification sent!')
      else toast.error(`Test failed: ${data.error}`)
    } catch {
      toast.error('Test failed')
    } finally {
      setTestingId(null)
    }
  }

  const typeColors: Record<string, string> = {
    gotify: 'text-blue-400 bg-blue-500/10 border-blue-500/20',
    pushover: 'text-orange-400 bg-orange-500/10 border-orange-500/20',
    telegram: 'text-sky-400 bg-sky-500/10 border-sky-500/20',
    email: 'text-purple-400 bg-purple-500/10 border-purple-500/20',
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Notifications</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Configure where alerts are delivered</p>
        </div>
        <Button size="sm" className="bg-blue-600 hover:bg-blue-700 gap-1.5" onClick={() => setAddOpen(true)}>
          <Plus className="h-4 w-4" />
          Add Channel
        </Button>
      </div>

      <div className="space-y-3">
        {channels.length === 0 && (
          <div className="glass-card p-8 text-center text-muted-foreground text-sm">
            No notification channels configured
          </div>
        )}
        {channels.map((ch) => (
          <div key={ch.id} className="glass-card p-4 flex items-center gap-3">
            <Badge className={`text-xs capitalize ${typeColors[ch.type] ?? ''}`}>{ch.type}</Badge>
            <span className="flex-1 text-sm font-medium">{ch.label}</span>
            <Switch
              checked={ch.enabled}
              onCheckedChange={(v) => toggleChannel(ch.id, v)}
              className="scale-90"
            />
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground hover:text-green-400"
              onClick={() => sendTest(ch.id)}
              disabled={testingId === ch.id}
              title="Send test notification"
            >
              {testingId === ch.id
                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                : <Send className="h-3.5 w-3.5" />
              }
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground hover:text-red-400"
              onClick={() => deleteChannel(ch.id)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
      </div>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="bg-zinc-900 border-border max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Add Notification Channel</DialogTitle>
          </DialogHeader>
          <AddChannelDialog
            onSave={() => { setAddOpen(false); fetchChannels() }}
            onClose={() => setAddOpen(false)}
          />
        </DialogContent>
      </Dialog>
    </div>
  )
}
