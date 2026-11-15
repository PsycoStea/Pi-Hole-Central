'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { toast } from 'sonner'
import { api, errorText } from '@/lib/client/api'
import { usePrimaryNode } from '@/lib/client/primary'
import { Trash2, Plus, Clock } from 'lucide-react'
import PageHeader from '@/components/dashboard/PageHeader'

interface Instance { id: string; name: string }
interface Group { id: number; name: string; enabled: boolean }
interface Schedule {
  id: string
  name: string
  enabled: boolean
  targetType: 'blocking' | 'group'
  targetGroup: string | null
  instanceIdsJson: string
  daysJson: string
  startTime: string
  endTime: string
  windowState: boolean
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const emptyForm = {
  name: '',
  targetType: 'blocking' as 'blocking' | 'group',
  targetGroup: '',
  instanceIds: [] as string[],
  days: [1, 2, 3, 4, 5],
  startTime: '09:00',
  endTime: '17:00',
  windowState: true,
}

export default function SchedulesPage() {
  const [schedules, setSchedules] = useState<Schedule[]>([])
  const [instances, setInstances] = useState<Instance[]>([])
  const [groups, setGroups] = useState<Group[]>([])
  const [form, setForm] = useState<typeof emptyForm>(emptyForm)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving] = useState(false)

  const fetchAll = useCallback(async () => {
    // Only ids/names are needed: /api/instances makes no node calls (P5.8).
    const [sRes, iRes] = await Promise.all([fetch('/api/schedules'), fetch('/api/instances')])
    if (sRes.ok) setSchedules(await sRes.json())
    if (iRes.ok) {
      const rows: (Instance & { enabled?: boolean })[] = await iRes.json()
      setInstances((Array.isArray(rows) ? rows : []).filter((i) => i.enabled).map((i) => ({ id: i.id, name: i.name })))
    }
  }, [])

  useEffect(() => { fetchAll() }, [fetchAll])

  // With a nebula-sync primary set, group schedules apply to every node (see
  // scheduleTargets on the server): groups are synced config, so a group
  // switched on one node only was undone or delayed by the next sync.
  const primary = usePrimaryNode()
  const groupOnAllNodes = form.targetType === 'group' && !!primary.primaryId

  // Load groups for the group picker: from the primary when one is set
  // (replicas copy its groups), else from the first selected instance.
  useEffect(() => {
    const first = groupOnAllNodes ? primary.primaryId : form.instanceIds[0]
    if (form.targetType !== 'group' || !first) return
    fetch(`/api/pihole/${first}/groups`)
      .then((r) => (r.ok ? r.json() : { groups: [] }))
      .then((d) => setGroups(d.groups ?? []))
      .catch(() => setGroups([]))
  }, [form.targetType, form.instanceIds, groupOnAllNodes, primary.primaryId])

  const resetForm = () => { setForm(emptyForm); setEditingId(null); setShowForm(false) }

  const startEdit = (s: Schedule) => {
    setForm({
      name: s.name,
      targetType: s.targetType,
      targetGroup: s.targetGroup ?? '',
      instanceIds: JSON.parse(s.instanceIdsJson),
      days: JSON.parse(s.daysJson),
      startTime: s.startTime,
      endTime: s.endTime,
      windowState: s.windowState,
    })
    setEditingId(s.id)
    setShowForm(true)
  }

  const save = async () => {
    if (!form.name.trim()) { toast.error('Name is required'); return }
    // Group schedules cover every node; store them all so the record says so.
    const payload = groupOnAllNodes ? { ...form, instanceIds: instances.map((i) => i.id) } : form
    if (payload.instanceIds.length === 0) { toast.error('Select at least one instance'); return }
    if (form.targetType === 'group' && !form.targetGroup) { toast.error('Select a group'); return }
    if (form.days.length === 0) { toast.error('Select at least one day'); return }
    setSaving(true)
    try {
      const res = await fetch('/api/schedules', {
        method: editingId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        // New schedules start enabled; an edit keeps whatever on/off it had.
        body: JSON.stringify(editingId ? { id: editingId, ...payload } : { ...payload, enabled: true }),
      })
      if (!res.ok) throw new Error((await res.json()).error ?? 'Save failed')
      toast.success(editingId ? 'Schedule updated' : 'Schedule created')
      resetForm()
      fetchAll()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const toggle = async (s: Schedule, enabled: boolean) => {
    setSchedules((prev) => prev.map((x) => (x.id === s.id ? { ...x, enabled } : x)))
    try {
      await api('/api/schedules', { method: 'PUT', json: { id: s.id, enabled } })
    } catch (err) {
      toast.error(errorText(err, 'Could not update schedule'))
      fetchAll()
    }
  }

  const remove = async (s: Schedule) => {
    if (!confirm(`Delete schedule "${s.name}"?`)) return
    try {
      await api('/api/schedules', { method: 'DELETE', json: { id: s.id } })
      toast.success('Schedule deleted')
    } catch (err) {
      toast.error(errorText(err, 'Delete failed'))
    }
    fetchAll()
  }

  const toggleIn = <T,>(arr: T[], v: T): T[] => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v])

  return (
    <div className="space-y-6 max-w-3xl">
      <PageHeader
        title="Schedules"
        description="Turn blocking (or a specific group) on/off on a recurring time window."
        actions={
          <>
            {!showForm && (
          <Button onClick={() => setShowForm(true)} className="gap-1.5">
            <Plus className="h-4 w-4" /> New schedule
          </Button>
        )}
          </>
        }
      />

      {showForm && (
        <div className="surface p-5 space-y-4">
          <div className="grid gap-3">
            <div>
              <Label className="text-xs text-muted-foreground">Name</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g. Bedtime block" className="bg-foreground/5 border-border" />
            </div>

            <div className="flex gap-4 flex-wrap">
              <div>
                <Label className="text-xs text-muted-foreground">Target</Label>
                <select value={form.targetType}
                  onChange={(e) => setForm({ ...form, targetType: e.target.value as 'blocking' | 'group' })}
                  className="block h-9 rounded-lg bg-background border border-border text-foreground text-sm px-2 mt-1">
                  <option value="blocking">Whole-node blocking</option>
                  <option value="group">Pi-hole group</option>
                </select>
              </div>
              {form.targetType === 'group' && (
                <div>
                  <Label className="text-xs text-muted-foreground">Group</Label>
                  <select value={form.targetGroup}
                    onChange={(e) => setForm({ ...form, targetGroup: e.target.value })}
                    className="block h-9 rounded-lg bg-background border border-border text-foreground text-sm px-2 mt-1">
                    <option value="">Select…</option>
                    {groups.map((g) => <option key={g.id} value={g.name}>{g.name}</option>)}
                  </select>
                </div>
              )}
              <div>
                <Label className="text-xs text-muted-foreground">During window</Label>
                <select value={form.windowState ? '1' : '0'}
                  onChange={(e) => setForm({ ...form, windowState: e.target.value === '1' })}
                  className="block h-9 rounded-lg bg-background border border-border text-foreground text-sm px-2 mt-1">
                  <option value="1">{form.targetType === 'blocking' ? 'Blocking ON' : 'Group enabled'}</option>
                  <option value="0">{form.targetType === 'blocking' ? 'Blocking OFF' : 'Group disabled'}</option>
                </select>
              </div>
            </div>

            <div className="flex gap-3">
              <div>
                <Label className="text-xs text-muted-foreground">Start</Label>
                <Input type="time" value={form.startTime} onChange={(e) => setForm({ ...form, startTime: e.target.value })}
                  className="bg-foreground/5 border-border w-32" />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">End</Label>
                <Input type="time" value={form.endTime} onChange={(e) => setForm({ ...form, endTime: e.target.value })}
                  className="bg-foreground/5 border-border w-32" />
              </div>
            </div>

            <div>
              <Label className="text-xs text-muted-foreground">Days</Label>
              <div className="flex gap-1.5 mt-1 flex-wrap">
                {DAYS.map((d, i) => (
                  <Button key={d} type="button" variant="ghost" size="sm"
                    onClick={() => setForm({ ...form, days: toggleIn(form.days, i) })}
                    className={`text-xs h-7 border ${form.days.includes(i) ? 'bg-primary/15 border-primary/30 text-primary' : 'bg-foreground/5 border-border text-muted-foreground'}`}>
                    {d}
                  </Button>
                ))}
              </div>
            </div>

            <div>
              <Label className="text-xs text-muted-foreground">Instances</Label>
              {groupOnAllNodes ? (
                <p className="text-xs text-muted-foreground mt-1">
                  All nodes. Groups are copied from {primary.primaryName ?? 'the primary'} by nebula-sync, so a group
                  schedule switches the group on every node at once.
                </p>
              ) : (
              <div className="flex gap-1.5 mt-1 flex-wrap">
                {instances.map((inst) => (
                  <Button key={inst.id} type="button" variant="ghost" size="sm"
                    onClick={() => setForm({ ...form, instanceIds: toggleIn(form.instanceIds, inst.id) })}
                    className={`text-xs h-7 border ${form.instanceIds.includes(inst.id) ? 'bg-primary/15 border-primary/30 text-primary' : 'bg-foreground/5 border-border text-muted-foreground'}`}>
                    {inst.name}
                  </Button>
                ))}
              </div>
              )}
            </div>

            <p className="text-[11px] text-muted-foreground">
              During the window the target is set as chosen; outside the window it is set to the opposite. The schedule owns the target while enabled.
            </p>
          </div>

          <div className="flex gap-2 justify-end">
            <Button variant="outline" size="sm" onClick={resetForm}>Cancel</Button>
            <Button size="sm" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : editingId ? 'Update' : 'Create'}
            </Button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {schedules.length === 0 ? (
          <p className="text-muted-foreground text-sm text-center py-8">No schedules yet</p>
        ) : (
          schedules.map((s) => {
            const days: number[] = JSON.parse(s.daysJson)
            return (
              <div key={s.id} className="surface p-4 flex items-center gap-3">
                <Clock className="h-4 w-4 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm">{s.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {s.targetType === 'blocking' ? 'Blocking' : `Group: ${s.targetGroup}`} ·{' '}
                    {s.windowState ? 'on' : 'off'} {s.startTime}–{s.endTime} ·{' '}
                    {days.length === 7 ? 'daily' : days.map((d) => DAYS[d]).join(' ')}
                  </p>
                </div>
                <Switch checked={s.enabled} onCheckedChange={(v) => toggle(s, v)} aria-label={`Schedule enabled: ${s.name}`} />
                <Button variant="ghost" size="sm" onClick={() => startEdit(s)} className="text-xs">Edit</Button>
                <Button variant="ghost" size="icon-sm" aria-label={`Delete schedule ${s.name}`} onClick={() => remove(s)}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
