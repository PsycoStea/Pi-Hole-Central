'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { toast } from 'sonner'
import { api, errorText } from '@/lib/client/api'
import { Trash2, Plus, MonitorSmartphone, Lock } from 'lucide-react'
import ReplicaNotice from '@/components/dashboard/ReplicaNotice'
import { usePrimaryNode, isEditableNode } from '@/lib/client/primary'
import PageHeader from '@/components/dashboard/PageHeader'

interface Instance { id: string; name: string; status?: 'online' | 'offline' }
interface Group { id: number; name: string }
interface Client {
  id: number
  client: string
  comment: string | null
  groups: number[]
  name?: string | null
}

export default function ClientsPage() {
  const [instances, setInstances] = useState<Instance[]>([])
  const [selected, setSelected] = useState('')
  const [clients, setClients] = useState<Client[]>([])
  const [groups, setGroups] = useState<Group[]>([])
  const [loading, setLoading] = useState(false)
  const [newClient, setNewClient] = useState('')
  const [newComment, setNewComment] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [editGroups, setEditGroups] = useState<number[]>([])

  useEffect(() => {
    fetch('/api/stats/summary')
      .then((r) => (r.ok ? r.json() : { instances: [] }))
      .then((d) => {
        setInstances((d.instances ?? []).map((i: Instance) => ({ id: i.id, name: i.name, status: i.status })))
      })
      .catch(() => {})
  }, [])

  // nebula-sync primary: when set, only it is editable (replicas are overwritten from it).
  const primary = usePrimaryNode()
  const primaryId = primary.primaryId
  const primaryOnline = instances.find((i) => i.id === primaryId)?.status !== 'offline'
  // Nothing is editable until the primary setting has loaded: treating "not
  // known yet" as "no primary" let an early click write to every node.
  const editable = primary.loaded && isEditableNode(primaryId, selected) && primaryOnline

  // Open on the primary once both the instances and the primary setting are known.
  const selectionInitialised = useRef(false)
  useEffect(() => {
    if (selectionInitialised.current || instances.length === 0 || !primary.loaded) return
    selectionInitialised.current = true
    // Never override a choice the user already made while these were loading.
    if (selected) return
    setSelected(primaryId && instances.some((i) => i.id === primaryId) ? primaryId : instances[0].id)
  }, [instances, primary.loaded, primaryId, selected])

  // Only the latest request may update the list: switching node or view while a
  // slower earlier request is in flight must not let its response land last.
  const fetchSeq = useRef(0)
  const fetchData = useCallback(async () => {
    const seq = ++fetchSeq.current
    if (!selected) return
    setLoading(true)
    try {
      const [cRes, gRes] = await Promise.all([
        fetch(`/api/pihole/${selected}/clients`),
        fetch(`/api/pihole/${selected}/groups`),
      ])
      if (seq === fetchSeq.current && cRes.ok) setClients((await cRes.json()).clients ?? [])
      if (seq === fetchSeq.current && gRes.ok) setGroups((await gRes.json()).groups ?? [])
    } catch {
      toast.error('Failed to load clients')
    } finally {
      if (seq === fetchSeq.current) setLoading(false)
    }
  }, [selected])

  useEffect(() => { fetchData() }, [fetchData])

  const groupName = (id: number) => groups.find((g) => g.id === id)?.name ?? `#${id}`

  const addClient = async () => {
    if (!newClient.trim()) return
    try {
      const res = await fetch(`/api/pihole/${selected}/clients`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client: newClient.trim(), comment: newComment.trim(), groups: [0] }),
      })
      if (!res.ok) throw new Error((await res.json()).error ?? 'Failed')
      toast.success(primaryId ? 'Client added; nebula-sync copies it to the other nodes within ~15 min' : 'Client added')
      setNewClient(''); setNewComment('')
      fetchData()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to add client')
    }
  }

  const saveGroups = async (c: Client) => {
    try {
      const res = await fetch(`/api/pihole/${selected}/clients`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client: c.client, groups: editGroups }),
      })
      if (!res.ok) throw new Error((await res.json()).error ?? 'Failed')
      toast.success('Groups updated')
      setEditing(null)
      fetchData()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to update groups')
    }
  }

  const remove = async (c: Client) => {
    if (!confirm(`Remove client ${c.client}?`)) return
    try {
      await api(`/api/pihole/${selected}/clients`, { method: 'DELETE', json: { client: c.client } })
      toast.success('Client removed')
    } catch (err) {
      toast.error(errorText(err, 'Remove failed'))
    }
    fetchData()
  }

  const toggleGroup = (id: number) =>
    setEditGroups((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))

  return (
    <div className="space-y-6 max-w-3xl">
      <PageHeader title="Clients" description="Assign clients to Pi-hole groups for per-device filtering." />

      <div className="flex items-center gap-3">
        <Label className="text-xs text-muted-foreground">Instance</Label>
        <select value={selected} onChange={(e) => { setSelected(e.target.value); setEditing(null) }}
          className="h-9 rounded-lg bg-background border border-border text-foreground text-sm px-3">
          {instances.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
        </select>
      </div>

      <ReplicaNotice
        primary={primary}
        selectedInstance={selected}
        primaryOnline={primaryOnline}
        thing="clients"
        onSwitchToPrimary={primaryId ? () => { setSelected(primaryId); setEditing(null) } : undefined}
      />

      {editable && (
      <div className="surface p-4 flex items-end gap-2 flex-wrap">
        <div className="flex-1 min-w-[10rem]">
          <Label className="text-xs text-muted-foreground">Client (IP / MAC / hostname)</Label>
          <Input value={newClient} onChange={(e) => setNewClient(e.target.value)} placeholder="192.168.1.50"
            className="bg-foreground/5 border-border" />
        </div>
        <div className="flex-1 min-w-[10rem]">
          <Label className="text-xs text-muted-foreground">Comment (optional)</Label>
          <Input value={newComment} onChange={(e) => setNewComment(e.target.value)} placeholder="Kids tablet"
            className="bg-foreground/5 border-border" />
        </div>
        <Button size="sm" onClick={addClient} className="gap-1.5">
          <Plus className="h-4 w-4" /> Add
        </Button>
      </div>
      )}

      <div className="space-y-2">
        {loading ? (
          <p className="text-muted-foreground text-sm text-center py-8 animate-pulse">Loading…</p>
        ) : clients.length === 0 ? (
          <p className="text-muted-foreground text-sm text-center py-8">No clients configured</p>
        ) : (
          clients.map((c) => (
            <div key={c.id} className="surface p-4">
              <div className="flex items-center gap-3">
                <MonitorSmartphone className="h-4 w-4 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="font-mono text-sm">{c.client}</p>
                  {c.comment && <p className="text-xs text-muted-foreground">{c.comment}</p>}
                </div>
                {editing === c.client ? (
                  <>
                    <Button variant="ghost" size="sm" className="text-xs" onClick={() => saveGroups(c)}>Save</Button>
                    <Button variant="ghost" size="sm" className="text-xs" onClick={() => setEditing(null)}>Cancel</Button>
                  </>
                ) : (
                  <>
                    <span className="text-xs text-muted-foreground">
                      {c.groups.length ? c.groups.map(groupName).join(', ') : 'no groups'}
                    </span>
                    {editable ? (
                      <>
                        <Button variant="ghost" size="sm" className="text-xs"
                          onClick={() => { setEditing(c.client); setEditGroups(c.groups) }}>
                          Groups
                        </Button>
                        <Button variant="ghost" size="icon-sm" aria-label="Remove" onClick={() => remove(c)}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </>
                    ) : (
                      <span title={`Synced from ${primary.primaryName ?? 'the primary'} by nebula-sync; change it there`}
                        className="inline-flex p-1 text-muted-foreground/50">
                        <Lock className="h-3.5 w-3.5" />
                      </span>
                    )}
                  </>
                )}
              </div>
              {editing === c.client && (
                <div className="flex flex-wrap gap-1.5 mt-3 pl-7">
                  {groups.map((g) => (
                    <Button key={g.id} type="button" variant="ghost" size="sm"
                      onClick={() => toggleGroup(g.id)}
                      className={`text-xs h-7 border ${editGroups.includes(g.id) ? 'bg-primary/15 border-primary/30 text-primary' : 'bg-foreground/5 border-border text-muted-foreground'}`}>
                      {g.name}
                    </Button>
                  ))}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
