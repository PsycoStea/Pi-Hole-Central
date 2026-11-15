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
import { api, errorText } from '@/lib/client/api'
import PageHeader from '@/components/dashboard/PageHeader'

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
    { key: 'tls', label: 'TLS: starttls (default, required) | implicit (port 465) | none (no login)', placeholder: 'starttls' },
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
      await api('/api/notifications/channels', { method: 'POST', json: { type, label, config } })
      toast.success('Notification channel added')
      onSave()
    } catch (err) {
      toast.error(`Failed to add channel: ${errorText(err)}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>Provider</Label>
        <Select value={type} onValueChange={(v) => { setType(v ?? 'gotify'); setConfig({}) }}>
          <SelectTrigger className="bg-foreground/5 border-border">
            <SelectValue />
          </SelectTrigger>
          <SelectContent >
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
          className="bg-foreground/5 border-border"
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
            className="bg-foreground/5 border-border"
          />
        </div>
      ))}
      <div className="flex gap-2 pt-2">
        <div className="flex-1" />
        <Button variant="ghost" size="sm" onClick={onClose} className="text-muted-foreground">Cancel</Button>
        <Button size="sm" onClick={handleSave} disabled={saving}>
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
    try {
      await api(`/api/notifications/channels/${id}`, { method: 'PUT', json: { enabled } })
    } catch (err) {
      toast.error(errorText(err, 'Could not update channel'))
    }
    fetchChannels()
  }

  async function deleteChannel(id: string) {
    if (!confirm('Delete this notification channel?')) return
    try {
      await api(`/api/notifications/channels/${id}`, { method: 'DELETE' })
      toast.success('Channel removed')
    } catch (err) {
      toast.error(errorText(err, 'Delete failed'))
    }
    fetchChannels()
  }

  async function sendTest(id: string) {
    setTestingId(id)
    try {
      const res = await fetch(`/api/notifications/channels/${id}/test`, { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data.ok) toast.success('Test notification sent!')
      else toast.error(`Test failed: ${data.error ?? `HTTP ${res.status}`}`)
    } catch (err) {
      toast.error(`Test failed: ${errorText(err)}`)
    } finally {
      setTestingId(null)
    }
  }

  const typeColors: Record<string, string> = {
    gotify: 'text-primary bg-primary/10 border-primary/20',
    pushover: 'text-warning bg-warning/10 border-warning/20',
    telegram: 'text-primary bg-primary/10 border-primary/20',
    email: 'text-primary bg-primary/10 border-primary/20',
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <PageHeader
        title="Notifications"
        description="Configure where alerts are delivered"
        actions={
          <>
            <Button className="gap-1.5" onClick={() => setAddOpen(true)}>
          <Plus className="h-4 w-4" />
          Add Channel
        </Button>
          </>
        }
      />

      <div className="space-y-3">
        {channels.length === 0 && (
          <div className="surface p-8 text-center text-muted-foreground text-sm">
            No notification channels configured
          </div>
        )}
        {channels.map((ch) => (
          <div key={ch.id} className="surface p-4 flex items-center gap-3">
            <Badge className={`text-xs capitalize ${typeColors[ch.type] ?? ''}`}>{ch.type}</Badge>
            <span className="flex-1 text-sm font-medium">{ch.label}</span>
            <Switch
              checked={ch.enabled}
              onCheckedChange={(v) => toggleChannel(ch.id, v)}
              className="scale-90"
              aria-label={`Channel enabled: ${ch.label}`}
            />
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground hover:text-success"
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
              className="h-8 w-8 text-muted-foreground hover:text-destructive"
              onClick={() => deleteChannel(ch.id)}
              aria-label={`Delete channel ${ch.label}`}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
      </div>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
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
