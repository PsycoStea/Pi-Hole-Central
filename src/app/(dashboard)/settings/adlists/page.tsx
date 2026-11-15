'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Plus, Trash2, RefreshCw, Zap, Check, X, Loader2, Pencil, Lock } from 'lucide-react'
import { toast } from 'sonner'
import { api, errorText } from '@/lib/client/api'
import { cn } from '@/lib/utils'
import ReplicaNotice from '@/components/dashboard/ReplicaNotice'
import { usePrimaryNode, isEditableNode } from '@/lib/client/primary'
import PageHeader from '@/components/dashboard/PageHeader'

interface AdList {
  id: number
  address: string
  comment: string
  enabled: boolean
  groups: number[]
  date_modified?: number
  instanceId?: string
  instanceName?: string
}

interface Group {
  id: number
  name: string
  description: string
  enabled: boolean
}

interface Instance {
  id: string
  name: string
  status?: 'online' | 'offline'
}

type GravityPhase = 'idle' | 'queued' | 'downloading' | 'parsing' | 'database' | 'done' | 'warn' | 'error'

interface GravityInstanceStatus {
  phase: GravityPhase
  detail?: string
  stageLabel: string
  startedAt?: number
  endedAt?: number
}

const GRAVITY_STAGES = [
  { phase: 'downloading' as const, label: 'Downloading block lists...', after: 0  },
  { phase: 'parsing'     as const, label: 'Processing domains...',       after: 15 },
  { phase: 'database'    as const, label: 'Updating gravity database...', after: 35 },
]

const RUNNING_PHASES: GravityPhase[] = ['downloading', 'parsing', 'database']

function formatDuration(startedAt: number, endedAt?: number) {
  const secs = Math.floor(((endedAt ?? Date.now()) - startedAt) / 1000)
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return m > 0 ? `${m}:${s.toString().padStart(2, '0')}` : `0:${s.toString().padStart(2, '0')}`
}

export default function AdlistsPage() {
  const [instances, setInstances] = useState<Instance[]>([])
  const [selectedInstance, setSelectedInstance] = useState<string>('')
  const [lists, setLists] = useState<AdList[]>([])
  const [loading, setLoading] = useState(false)
  const [showAddForm, setShowAddForm] = useState(false)

  // Per-instance groups map — used for name resolution in the table
  const [instanceGroupsMap, setInstanceGroupsMap] = useState<Record<string, Group[]>>({})

  // Add form state — groups loaded for single-instance target
  const [addFormGroups, setAddFormGroups] = useState<Group[]>([])
  const [newAddress, setNewAddress] = useState('')
  const [newComment, setNewComment] = useState('')
  const [newEnabled, setNewEnabled] = useState(true)
  const [newGroups, setNewGroups] = useState<number[]>([0])
  const [targetInstances, setTargetInstances] = useState<string[]>([])
  const [adding, setAdding] = useState(false)

  // Inline group edit state
  const [editingGroupsId, setEditingGroupsId] = useState<number | null>(null)
  const [editingGroups, setEditingGroups] = useState<number[]>([])
  const [savingGroups, setSavingGroups] = useState(false)

  // Gravity panel state
  const [gravityTargets, setGravityTargets] = useState<string[]>([])
  const [gravityStatus, setGravityStatus] = useState<Record<string, GravityInstanceStatus>>({})
  const [gravityRunning, setGravityRunning] = useState(false)
  const gravityTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>[]>>({})
  const [, setTick] = useState(0)

  const isAllInstances = selectedInstance === '__all__'

  // nebula-sync primary: when set, only it is editable (replicas are overwritten from it).
  const primary = usePrimaryNode()
  const primaryId = primary.primaryId
  const primaryOnline = instances.find((i) => i.id === primaryId)?.status !== 'offline'
  // Nothing is editable until the primary setting has loaded: treating "not
  // known yet" as "no primary" let an early click write to every node.
  const canAdd = primary.loaded && (!primaryId || ((isAllInstances || selectedInstance === primaryId) && primaryOnline))
  const replicaNames = instances.filter((i) => primaryId && i.id !== primaryId).map((i) => i.name)

  // Load instances
  useEffect(() => {
    fetch('/api/stats/summary')
      .then((r) => r.json())
      .then((data) => {
        const insts: Instance[] = (data.instances ?? []).map((i: Instance) => ({
          id: i.id,
          name: i.name,
          status: i.status,
        }))
        setInstances(insts)
        setGravityTargets(insts.map((i) => i.id))
      })
      .catch(() => {})
  }, [])

  // Initial selection, once instances and the primary setting are both known:
  // open on the primary (the editable node) when one is chosen.
  const selectionInitialised = useRef(false)
  useEffect(() => {
    if (selectionInitialised.current || instances.length === 0 || !primary.loaded) return
    selectionInitialised.current = true
    // Never override a choice the user already made while these were loading.
    if (selectedInstance) return
    if (primaryId && instances.some((i) => i.id === primaryId)) setSelectedInstance(primaryId)
    else setSelectedInstance(instances.length > 1 ? '__all__' : instances[0].id)
  }, [instances, primary.loaded, primaryId, selectedInstance])

  // Fetch groups for all instances upfront (for name resolution in table)
  useEffect(() => {
    if (instances.length === 0) return
    instances.forEach(async (inst) => {
      try {
        const res = await fetch(`/api/pihole/${inst.id}/groups`)
        if (!res.ok) return
        const data = await res.json()
        setInstanceGroupsMap((prev) => ({ ...prev, [inst.id]: data.groups ?? [] }))
      } catch {
        // ignore — group names fall back to IDs
      }
    })
  }, [instances])

  // Sync gravity targets when view selector changes
  useEffect(() => {
    if (!selectedInstance) return
    setGravityTargets(
      selectedInstance === '__all__' ? instances.map((i) => i.id) : [selectedInstance]
    )
  }, [selectedInstance, instances])

  // Re-render every second while gravity is running (for elapsed timer display)
  useEffect(() => {
    if (!gravityRunning) return
    const id = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(id)
  }, [gravityRunning])

  // Flush any pending gravity stage timers on unmount so their callbacks don't
  // fire setState on an unmounted component (e.g. navigating away mid-update).
  useEffect(() => {
    const timers = gravityTimersRef.current
    return () => {
      Object.values(timers).forEach((handles) => handles.forEach(clearTimeout))
    }
  }, [])

  // Load adlists
  // Only the latest request may update the list: switching node or view while a
  // slower earlier request is in flight must not let its response land last.
  const fetchSeq = useRef(0)
  const fetchLists = useCallback(async () => {
    const seq = ++fetchSeq.current
    if (!selectedInstance) return
    setLoading(true)
    try {
      const url = isAllInstances
        ? '/api/pihole/lists'
        : `/api/pihole/${selectedInstance}/lists`
      const res = await fetch(url)
      if (!res.ok) return
      const data = await res.json()
      if (seq !== fetchSeq.current) return
      setLists(data.lists ?? [])
      if (data.failures?.length) {
        toast.warning(
          `Could not load adlists from: ${data.failures.map((f: { name: string }) => f.name).join(', ')}`
        )
      }
    } catch {
      // ignore
    } finally {
      if (seq === fetchSeq.current) setLoading(false)
    }
  }, [selectedInstance, isAllInstances])

  useEffect(() => {
    if (selectedInstance) fetchLists()
  }, [selectedInstance, fetchLists])

  // Load groups for the add form (single-instance target)
  const fetchAddFormGroups = useCallback(async (instanceId: string) => {
    if (!instanceId || instanceId === '__all__') { setAddFormGroups([]); return }
    // Reuse already-loaded map if available
    if (instanceGroupsMap[instanceId]) {
      setAddFormGroups(instanceGroupsMap[instanceId])
      return
    }
    try {
      const res = await fetch(`/api/pihole/${instanceId}/groups`)
      if (!res.ok) return
      const data = await res.json()
      setAddFormGroups(data.groups ?? [])
    } catch {
      setAddFormGroups([])
    }
  }, [instanceGroupsMap])

  // When the add form opens, initialize targets and load groups
  useEffect(() => {
    if (!showAddForm) return
    if (primaryId) {
      // Adds always go to the primary; nebula-sync copies them to the replicas.
      setTargetInstances([primaryId])
      fetchAddFormGroups(primaryId)
    } else if (isAllInstances) {
      setTargetInstances(instances.map((i) => i.id))
      setAddFormGroups([])
    } else {
      setTargetInstances([selectedInstance])
      fetchAddFormGroups(selectedInstance)
    }
    setNewGroups([0])
  }, [showAddForm, isAllInstances, selectedInstance, instances, fetchAddFormGroups, primaryId])

  // In All view: reload add form groups when target narrows to one instance
  useEffect(() => {
    if (!isAllInstances || !showAddForm) return
    if (targetInstances.length === 1) {
      fetchAddFormGroups(targetInstances[0])
    } else {
      setAddFormGroups([])
    }
    setNewGroups([0])
  }, [targetInstances, isAllInstances, showAddForm, fetchAddFormGroups])

  // Resolve group IDs to names for display
  function resolveGroupNames(groupIds: number[], instanceId: string): string[] {
    const grps = instanceGroupsMap[instanceId] ?? []
    if (grps.length === 0) return groupIds.map(String)
    return groupIds.map((id) => grps.find((g) => g.id === id)?.name ?? String(id))
  }

  function toggleTargetInstance(id: string) {
    setTargetInstances((prev) =>
      prev.includes(id) ? prev.filter((i) => i !== id) : [...prev, id]
    )
  }

  function toggleNewGroup(id: number) {
    setNewGroups((prev) => prev.includes(id) ? prev.filter((g) => g !== id) : [...prev, id])
  }

  function toggleEditGroup(id: number) {
    setEditingGroups((prev) => prev.includes(id) ? prev.filter((g) => g !== id) : [...prev, id])
  }

  function toggleGravityTarget(id: string) {
    setGravityTargets((prev) =>
      prev.includes(id) ? prev.filter((i) => i !== id) : [...prev, id]
    )
  }

  function startEditGroups(list: AdList) {
    setEditingGroupsId(list.id)
    setEditingGroups([...list.groups])
  }

  function cancelEditGroups() {
    setEditingGroupsId(null)
    setEditingGroups([])
  }

  async function handleAdd() {
    if (!newAddress.trim()) return
    setAdding(true)
    const targets = primaryId ? [primaryId] : isAllInstances ? targetInstances : [selectedInstance]
    if (targets.length === 0) { toast.error('Select at least one instance'); setAdding(false); return }

    const groupsToUse = addFormGroups.length > 0 && targetInstances.length === 1 ? newGroups : [0]
    const errors: string[] = []

    await Promise.allSettled(
      targets.map(async (instanceId) => {
        const res = await fetch(`/api/pihole/${instanceId}/lists`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            address: newAddress.trim(),
            comment: newComment.trim(),
            enabled: newEnabled,
            groups: groupsToUse,
          }),
        })
        if (!res.ok) {
          const data = await res.json().catch(() => ({}))
          const instName = instances.find((i) => i.id === instanceId)?.name ?? instanceId
          errors.push(`${instName}: ${(data.error as string) ?? res.status}`)
        }
      })
    )

    if (errors.length > 0) {
      // Keep the form filled in so a fix-and-retry doesn't mean retyping.
      toast.error(`Failed: ${errors.join(', ')}`, { duration: 10000 })
    } else {
      toast.success(primaryId
        ? `Adlist added to ${primary.primaryName ?? 'the primary'}. nebula-sync copies it to the other nodes within ~15 min; run gravity on each node to start blocking.`
        : `Adlist added to ${targets.length > 1 ? `${targets.length} instances` : 'instance'}`, primaryId ? { duration: 10000 } : undefined)
      setNewAddress('')
      setNewComment('')
      setNewEnabled(true)
      setNewGroups([0])
      setShowAddForm(false)
    }
    fetchLists()
    setAdding(false)
  }

  async function handleDelete(list: AdList) {
    const instanceId = list.instanceId ?? selectedInstance
    if (!window.confirm(`Remove this adlist?\n\n${list.address}\n\nIts domains stop being blocked after the next gravity update.`)) return
    try {
      await api(`/api/pihole/${instanceId}/lists/${encodeURIComponent(list.address)}`, { method: 'DELETE' })
      toast.success('Adlist removed')
    } catch (err) {
      toast.error(`Failed to remove adlist: ${errorText(err)}`)
    }
    fetchLists()
  }

  async function handleToggleEnabled(list: AdList, enabled: boolean) {
    const instanceId = list.instanceId ?? selectedInstance
    // Optimistic update
    setLists((prev) =>
      prev.map((l) =>
        l.id === list.id && (l.instanceId ?? selectedInstance) === instanceId
          ? { ...l, enabled }
          : l
      )
    )
    const res = await fetch(`/api/pihole/${instanceId}/lists/${list.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        address: list.address,
        comment: list.comment,
        enabled,
        groups: list.groups,
      }),
    })
    if (!res.ok) {
      // Revert
      setLists((prev) =>
        prev.map((l) =>
          l.id === list.id && (l.instanceId ?? selectedInstance) === instanceId
            ? { ...l, enabled: list.enabled }
            : l
        )
      )
      const d = await res.json().catch(() => ({}))
      toast.error(`Failed to update adlist: ${d.error ?? `HTTP ${res.status}`}`)
    }
  }

  async function handleSaveGroups(list: AdList) {
    if (editingGroups.length === 0) { toast.error('Select at least one group'); return }
    setSavingGroups(true)
    const instanceId = selectedInstance
    const res = await fetch(`/api/pihole/${instanceId}/lists/${list.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        address: list.address,
        comment: list.comment,
        enabled: list.enabled,
        groups: editingGroups,
      }),
    })
    if (res.ok) {
      toast.success('Groups updated')
      cancelEditGroups()
      fetchLists()
    } else {
      const d = await res.json().catch(() => ({}))
      toast.error(`Failed to update groups: ${d.error ?? `HTTP ${res.status}`}`)
    }
    setSavingGroups(false)
  }

  async function handleGravity() {
    if (gravityTargets.length === 0) { toast.error('Select at least one instance'); return }
    setGravityRunning(true)

    // One node at a time (the server queues gravity globally anyway, and
    // running both at once trips GitHub's per-IP limit on list downloads).
    // Later nodes show "Queued" until their turn instead of a fake progress.
    const initial: Record<string, GravityInstanceStatus> = {}
    instances.forEach((i) => {
      initial[i.id] = gravityTargets.includes(i.id)
        ? { phase: 'queued', stageLabel: 'Queued' }
        : { phase: 'idle', stageLabel: '' }
    })
    setGravityStatus(initial)

    const finish = (instanceId: string, st: Omit<GravityInstanceStatus, 'startedAt' | 'endedAt'>) => {
      gravityTimersRef.current[instanceId]?.forEach(clearTimeout)
      delete gravityTimersRef.current[instanceId]
      const endedAt = Date.now()
      setGravityStatus((prev) => ({ ...prev, [instanceId]: { ...st, startedAt: prev[instanceId]?.startedAt, endedAt } }))
    }

    let done = 0
    const failures: string[] = []
    for (const instanceId of instances.map((i) => i.id).filter((id) => gravityTargets.includes(id))) {
      const name = instances.find((i) => i.id === instanceId)?.name ?? instanceId
      const startedAt = Date.now()
      setGravityStatus((prev) => ({ ...prev, [instanceId]: { phase: 'downloading', stageLabel: GRAVITY_STAGES[0].label, startedAt } }))
      gravityTimersRef.current[instanceId] = GRAVITY_STAGES.slice(1).map(({ phase, label, after }) =>
        setTimeout(() => {
          setGravityStatus((prev) => {
            const st = prev[instanceId]
            if (!st || !RUNNING_PHASES.includes(st.phase)) return prev
            return { ...prev, [instanceId]: { ...st, phase, stageLabel: label } }
          })
        }, after * 1000)
      )
      try {
        const data = await api<{ failedLists?: number; message?: string }>(`/api/pihole/${instanceId}/gravity`, { method: 'POST' })
        done++
        if (data.failedLists) finish(instanceId, { phase: 'warn', stageLabel: 'Done', detail: `${data.failedLists} list download(s) failed` })
        else finish(instanceId, { phase: 'done', stageLabel: 'Done' })
      } catch (err) {
        failures.push(`${name}: ${errorText(err)}`)
        finish(instanceId, { phase: 'error', stageLabel: 'Error', detail: errorText(err) })
      }
    }

    if (failures.length === 0) {
      toast.success(`Gravity updated on ${done} ${done === 1 ? 'instance' : 'instances'}`)
    } else {
      toast.error(`Gravity failed on ${failures.join(', ')}`, { duration: 12000 })
    }

    setGravityRunning(false)
  }

  const showAddFormGroupSelector =
    addFormGroups.length > 0 && (!isAllInstances || targetInstances.length === 1)
  const anyGravityActive = Object.values(gravityStatus).some((s) => s.phase !== 'idle')

  return (
    <div className="space-y-6">
      <PageHeader title="Adlists" description="Manage subscription block lists" />

      {/* Controls */}
      <div className="surface p-4">
        <div className="flex flex-wrap gap-3 items-end">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground">Instance</label>
            <select
              value={selectedInstance}
              onChange={(e) => { setSelectedInstance(e.target.value); setShowAddForm(false); cancelEditGroups() }}
              className="bg-foreground/5 border border-border rounded-md px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-foreground/20"
            >
              <option value="__all__">All Instances</option>
              {instances.map((inst) => (
                <option key={inst.id} value={inst.id}>{inst.name}</option>
              ))}
            </select>
          </div>

          <div className="flex gap-2 ml-auto items-end pb-0.5">
            <Button size="sm" variant="outline" onClick={fetchLists} disabled={loading}
              className="border-border text-foreground/70 hover:text-foreground gap-1.5">
              <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
              Refresh
            </Button>
            {canAdd && (
              <Button size="sm" onClick={() => setShowAddForm((v) => !v)} className="gap-1.5">
                <Plus className="h-3.5 w-3.5" />
                Add Adlist
              </Button>
            )}
          </div>
        </div>
      </div>

      <ReplicaNotice
        primary={primary}
        selectedInstance={selectedInstance}
        primaryOnline={primaryOnline}
        thing="adlists"
        onSwitchToPrimary={primaryId ? () => { setSelectedInstance(primaryId); setShowAddForm(false); cancelEditGroups() } : undefined}
      />

      {/* Add Form */}
      {showAddForm && canAdd && (
        <div className="surface p-4 space-y-4">
          <h3 className="text-sm font-medium text-foreground/70">Add subscription list</h3>

          <div className="flex flex-wrap gap-3 items-start">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">URL *</label>
              <input
                type="url"
                value={newAddress}
                onChange={(e) => setNewAddress(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
                placeholder="https://example.com/blocklist.txt"
                className="bg-foreground/5 border border-border rounded-md px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-foreground/20 w-80"
                autoFocus
              />
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">Comment</label>
              <input
                type="text"
                value={newComment}
                onChange={(e) => setNewComment(e.target.value)}
                placeholder="Optional note"
                className="bg-foreground/5 border border-border rounded-md px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-foreground/20 w-44"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">Enabled</label>
              <div className="flex items-center h-[34px]">
                <Switch checked={newEnabled} onCheckedChange={setNewEnabled} aria-label="Enabled" />
              </div>
            </div>

            {showAddFormGroupSelector && (
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-foreground">Groups</label>
                <div className="flex flex-wrap gap-1">
                  {addFormGroups.map((g) => (
                    <button
                      key={g.id}
                      onClick={() => toggleNewGroup(g.id)}
                      className={cn(
                        'px-2.5 py-1 rounded text-xs transition-colors cursor-pointer',
                        newGroups.includes(g.id)
                          ? 'bg-primary/20 text-primary'
                          : 'bg-foreground/5 text-muted-foreground hover:bg-foreground/10'
                      )}
                    >
                      {g.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {isAllInstances && !primaryId && (
            <div className="flex flex-col gap-1.5">
              <label className="text-xs text-muted-foreground">Add to instances</label>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() =>
                    setTargetInstances(
                      targetInstances.length === instances.length ? [] : instances.map((i) => i.id)
                    )
                  }
                  className="px-2.5 py-1 rounded text-xs bg-foreground/10 text-foreground/60 hover:bg-foreground/15 cursor-pointer transition-colors"
                >
                  {targetInstances.length === instances.length ? 'Deselect All' : 'Select All'}
                </button>
                {instances.map((inst) => (
                  <button
                    key={inst.id}
                    onClick={() => toggleTargetInstance(inst.id)}
                    className={cn(
                      'px-2.5 py-1 rounded text-xs transition-colors cursor-pointer',
                      targetInstances.includes(inst.id)
                        ? 'bg-primary/20 text-primary'
                        : 'bg-foreground/5 text-muted-foreground hover:bg-foreground/10'
                    )}
                  >
                    {inst.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="flex gap-2">
            <Button size="sm" onClick={handleAdd} disabled={adding || !newAddress.trim()}>
              {adding ? 'Adding...' : 'Add'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setShowAddForm(false)}
              className="text-muted-foreground hover:text-foreground">
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* Adlists table */}
      <div className="surface overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-muted-foreground text-sm animate-pulse">Loading adlists...</div>
        ) : lists.length === 0 ? (
          <div className="p-8 text-center text-muted-foreground text-sm">No adlists found</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-sm">
              <thead>
                <tr className="border-b border-border">
                  {isAllInstances && (
                    <th className="text-left px-4 py-3 text-muted-foreground font-medium whitespace-nowrap">Instance</th>
                  )}
                  <th className="text-left px-4 py-3 text-muted-foreground font-medium">Address</th>
                  <th className="text-left px-4 py-3 text-muted-foreground font-medium">Comment</th>
                  <th className="text-left px-4 py-3 text-muted-foreground font-medium whitespace-nowrap">Enabled</th>
                  <th className="text-left px-4 py-3 text-muted-foreground font-medium">Groups</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {lists.map((l, i) => {
                  const rowInstanceId = l.instanceId ?? selectedInstance
                  const isEditing = editingGroupsId === l.id && !isAllInstances
                  const rowGroups = instanceGroupsMap[rowInstanceId] ?? []
                  const rowEditable = primary.loaded && isEditableNode(primaryId, rowInstanceId) && primaryOnline

                  return (
                    <tr
                      key={`${l.id}-${l.instanceId ?? ''}-${i}`}
                      className="border-b border-border hover:bg-foreground/3 transition-colors"
                    >
                      {isAllInstances && (
                        <td className="px-4 py-2.5">
                          <span className="inline-block px-2 py-0.5 rounded text-xs bg-foreground/8 text-foreground/60 whitespace-nowrap">
                            {l.instanceName ?? l.instanceId ?? '—'}
                          </span>
                        </td>
                      )}
                      <td className="px-4 py-2.5 text-foreground font-mono text-xs max-w-[20rem] truncate">
                        <a
                          href={l.address}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={l.address}
                          className="hover:text-primary transition-colors"
                        >
                          {l.address}
                        </a>
                      </td>
                      <td className="px-4 py-2.5 text-muted-foreground text-xs max-w-[12rem] truncate">
                        {l.comment || '—'}
                      </td>
                      <td className="px-4 py-2.5">
                        <Switch
                          checked={l.enabled}
                          onCheckedChange={(val) => handleToggleEnabled(l, val)}
                          disabled={!rowEditable}
                          aria-label={`Adlist enabled: ${l.address}`}
                        />
                      </td>
                      <td className="px-4 py-2.5 min-w-[10rem]">
                        {isEditing ? (
                          <div className="flex flex-col gap-2">
                            <div className="flex flex-wrap gap-1">
                              {rowGroups.map((g) => (
                                <button
                                  key={g.id}
                                  onClick={() => toggleEditGroup(g.id)}
                                  className={cn(
                                    'px-2 py-0.5 rounded text-xs transition-colors cursor-pointer',
                                    editingGroups.includes(g.id)
                                      ? 'bg-primary/20 text-primary'
                                      : 'bg-foreground/5 text-muted-foreground hover:bg-foreground/10'
                                  )}
                                >
                                  {g.name}
                                </button>
                              ))}
                            </div>
                            <div className="flex gap-1.5">
                              <button
                                onClick={() => handleSaveGroups(l)}
                                disabled={savingGroups}
                                className="px-2 py-0.5 rounded text-xs bg-primary/20 text-primary hover:bg-primary/30 transition-colors cursor-pointer disabled:opacity-50"
                              >
                                {savingGroups ? 'Saving...' : 'Save'}
                              </button>
                              <button
                                onClick={cancelEditGroups}
                                className="px-2 py-0.5 rounded text-xs bg-foreground/5 text-muted-foreground hover:bg-foreground/10 transition-colors cursor-pointer"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1.5 flex-wrap">
                            {resolveGroupNames(l.groups ?? [], rowInstanceId).map((name, gi) => (
                              <span
                                key={gi}
                                data-slot="group-chip"
                                className="inline-block px-1.5 py-0.5 rounded text-xs bg-primary/15 text-primary"
                              >
                                {name}
                              </span>
                            ))}
                            {!isAllInstances && rowEditable && (
                              <button
                                onClick={() => startEditGroups(l)}
                                className="p-0.5 rounded text-muted-foreground/40 hover:text-primary hover:bg-primary/10 transition-colors cursor-pointer"
                                title="Edit groups"
                              >
                                <Pencil className="h-3 w-3" />
                              </button>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        {rowEditable ? (
                          <button
                            onClick={() => handleDelete(l)}
                            aria-label={`Remove adlist ${l.address}`}
                            className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors cursor-pointer"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        ) : (
                          <span
                            title={`Synced from ${primary.primaryName ?? 'the primary'} by nebula-sync; change it there`}
                            className="inline-flex p-1 text-muted-foreground/50"
                          >
                            <Lock className="h-3.5 w-3.5" />
                          </span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Gravity Panel */}
      <div className="surface p-4 space-y-4">
        <div className="flex items-center gap-2">
          <Zap className="h-4 w-4 text-warning" />
          <h3 className="text-sm font-medium">Update Gravity</h3>
          <span className="text-xs text-muted-foreground ml-1">— download and apply selected block lists</span>
        </div>

        {primaryId && replicaNames.length > 0 && (
          <p className="text-xs text-muted-foreground">
            nebula-sync copies adlist <em>settings</em> to {replicaNames.join(', ')} but does not rebuild{' '}
            {replicaNames.length === 1 ? 'its' : 'their'} gravity. After adding or changing an adlist, wait for the next
            sync (up to ~15 min), then run gravity on {replicaNames.length === 1 ? replicaNames[0] : 'each replica'} too;
            until then the Sync page shows drift.
          </p>
        )}

        {instances.length > 0 && (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap gap-2 items-center">
              <button
                onClick={() =>
                  setGravityTargets(
                    gravityTargets.length === instances.length ? [] : instances.map((i) => i.id)
                  )
                }
                className="px-2.5 py-1 rounded text-xs bg-foreground/10 text-foreground/60 hover:bg-foreground/15 cursor-pointer transition-colors"
              >
                {gravityTargets.length === instances.length ? 'Deselect All' : 'Select All'}
              </button>
            </div>

            <div className="flex flex-col gap-1.5">
              {instances.map((inst) => {
                const status = gravityStatus[inst.id] ?? { phase: 'idle' as GravityPhase, stageLabel: '' }
                const isSelected = gravityTargets.includes(inst.id)
                return (
                  <div key={inst.id} className="flex items-center gap-3">
                    <button
                      onClick={() => !gravityRunning && toggleGravityTarget(inst.id)}
                      disabled={gravityRunning}
                      aria-pressed={isSelected}
                      className={cn(
                        'flex items-center gap-2 px-3 py-1.5 rounded text-xs transition-colors cursor-pointer',
                        isSelected
                          ? 'bg-primary/20 text-primary'
                          : 'bg-foreground/5 text-muted-foreground hover:bg-foreground/10',
                        gravityRunning && 'cursor-not-allowed opacity-70'
                      )}
                    >
                      {inst.name}
                    </button>

                    {anyGravityActive && status.phase !== 'idle' && (
                      <span className={cn(
                        'inline-flex items-center gap-1.5 text-xs',
                        RUNNING_PHASES.includes(status.phase) && 'text-warning',
                        status.phase === 'done'  && 'text-success',
                        status.phase === 'warn'  && 'text-warning',
                        status.phase === 'error' && 'text-destructive',
                        status.phase === 'queued' && 'text-muted-foreground',
                      )}>
                        {status.phase === 'queued' && 'Queued'}
                        {RUNNING_PHASES.includes(status.phase) && (
                          <>
                            <Loader2 className="h-3 w-3 animate-spin" />
                            {status.stageLabel}
                            {status.startedAt && (
                              <span className="text-warning/60">{formatDuration(status.startedAt)}</span>
                            )}
                          </>
                        )}
                        {(status.phase === 'done' || status.phase === 'warn') && (
                          <>
                            <Check className="h-3 w-3" />
                            Done
                            {status.startedAt && status.endedAt && (
                              <span className="text-success/60">{formatDuration(status.startedAt, status.endedAt)}</span>
                            )}
                          </>
                        )}
                        {status.phase === 'warn' && <span>· {status.detail}</span>}
                        {status.phase === 'error' && <><X className="h-3 w-3" />Error{status.detail && <span className="text-destructive/70">· {status.detail}</span>}</>}
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        <Button
          size="sm"
          onClick={handleGravity}
          disabled={gravityRunning || gravityTargets.length === 0}
          className="gap-1.5"
        >
          {gravityRunning
            ? <><Loader2 className="h-3.5 w-3.5 animate-spin" />Updating...</>
            : <><Zap className="h-3.5 w-3.5" />Update Gravity</>
          }
        </Button>
      </div>
    </div>
  )
}
