'use client'

import { useEffect, useState, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { FilterX, Plus, Trash2, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

interface Domain {
  id: number
  domain: string
  kind: 'exact' | 'regex'
  comment: string
  enabled: boolean
  groups: number[]
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
}

type ListType = 'allow' | 'deny'

export default function DomainsPage() {
  const [instances, setInstances] = useState<Instance[]>([])
  const [selectedInstance, setSelectedInstance] = useState<string>('')
  const [activeTab, setActiveTab] = useState<ListType>('allow')
  const [domains, setDomains] = useState<Domain[]>([])
  const [groups, setGroups] = useState<Group[]>([])
  const [loading, setLoading] = useState(false)
  const [showAddForm, setShowAddForm] = useState(false)

  // Add form state
  const [newDomain, setNewDomain] = useState('')
  const [newKind, setNewKind] = useState<'exact' | 'regex'>('exact')
  const [newComment, setNewComment] = useState('')
  const [newEnabled, setNewEnabled] = useState(true)
  const [newGroups, setNewGroups] = useState<number[]>([0])
  const [targetInstances, setTargetInstances] = useState<string[]>([])
  const [adding, setAdding] = useState(false)

  const isAllInstances = selectedInstance === '__all__'

  // Load instances
  useEffect(() => {
    fetch('/api/stats/summary')
      .then((r) => r.json())
      .then((data) => {
        const insts: Instance[] = (data.instances ?? []).map((i: Instance) => ({
          id: i.id,
          name: i.name,
        }))
        setInstances(insts)
        setSelectedInstance(insts.length > 1 ? '__all__' : (insts[0]?.id ?? ''))
      })
      .catch(() => {})
  }, [])

  // Load domains
  const fetchDomains = useCallback(async () => {
    if (!selectedInstance) return
    setLoading(true)
    try {
      const url = isAllInstances
        ? `/api/pihole/domains?list=${activeTab}`
        : `/api/pihole/${selectedInstance}/domains?list=${activeTab}`
      const res = await fetch(url)
      if (!res.ok) return
      const data = await res.json()
      setDomains(data.domains ?? [])
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }, [selectedInstance, activeTab, isAllInstances])

  useEffect(() => {
    if (selectedInstance) fetchDomains()
  }, [selectedInstance, activeTab, fetchDomains])

  // Load groups for a single instance
  const fetchGroups = useCallback(async (instanceId: string) => {
    if (!instanceId || instanceId === '__all__') { setGroups([]); return }
    try {
      const res = await fetch(`/api/pihole/${instanceId}/groups`)
      if (!res.ok) return
      const data = await res.json()
      setGroups(data.groups ?? [])
    } catch {
      setGroups([])
    }
  }, [])

  // When the add form opens, initialize targets and load groups
  useEffect(() => {
    if (!showAddForm) return
    if (isAllInstances) {
      setTargetInstances(instances.map((i) => i.id))
      setGroups([])
    } else {
      setTargetInstances([selectedInstance])
      fetchGroups(selectedInstance)
    }
    setNewGroups([0])
  }, [showAddForm, isAllInstances, selectedInstance, instances, fetchGroups])

  // In All view: reload groups when target narrows to one instance
  useEffect(() => {
    if (!isAllInstances || !showAddForm) return
    if (targetInstances.length === 1) {
      fetchGroups(targetInstances[0])
    } else {
      setGroups([])
    }
    setNewGroups([0])
  }, [targetInstances, isAllInstances, showAddForm, fetchGroups])

  function toggleTargetInstance(id: string) {
    setTargetInstances((prev) =>
      prev.includes(id) ? prev.filter((i) => i !== id) : [...prev, id]
    )
  }

  function toggleGroup(id: number) {
    setNewGroups((prev) => prev.includes(id) ? prev.filter((g) => g !== id) : [...prev, id])
  }

  async function handleAdd() {
    if (!newDomain.trim()) return
    setAdding(true)
    const targets = isAllInstances ? targetInstances : [selectedInstance]
    if (targets.length === 0) { toast.error('Select at least one instance'); setAdding(false); return }

    const groupsToUse = groups.length > 0 && targetInstances.length === 1 ? newGroups : [0]
    const errors: string[] = []

    await Promise.allSettled(
      targets.map(async (instanceId) => {
        const res = await fetch(`/api/pihole/${instanceId}/domains`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            domain: newDomain.trim(),
            list: activeTab,
            kind: newKind,
            comment: newComment.trim(),
            groups: groupsToUse,
            enabled: newEnabled,
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
      toast.error(`Failed: ${errors.join(', ')}`)
    } else {
      toast.success(`Domain added to ${targets.length > 1 ? `${targets.length} instances` : 'instance'}`)
    }

    setNewDomain('')
    setNewComment('')
    setNewKind('exact')
    setNewEnabled(true)
    setNewGroups([0])
    setShowAddForm(false)
    fetchDomains()
    setAdding(false)
  }

  async function handleDelete(domain: Domain) {
    const instanceId = domain.instanceId ?? selectedInstance
    const res = await fetch(`/api/pihole/${instanceId}/domains`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ list: activeTab, kind: domain.kind, id: domain.id }),
    })
    if (res.ok) {
      toast.success('Domain removed')
      fetchDomains()
    } else {
      toast.error('Failed to remove domain')
    }
  }

  const showGroupSelector = groups.length > 0 && (!isAllInstances || targetInstances.length === 1)

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <FilterX className="h-6 w-6 text-white/50" />
        <div>
          <h1 className="text-2xl font-bold">Domains</h1>
          <p className="text-sm text-white/40 mt-0.5">Manage allowlists and denylists</p>
        </div>
      </div>

      {/* Controls */}
      <div className="glass-card p-4">
        <div className="flex flex-wrap gap-3 items-end">
          {/* Instance selector */}
          <div className="flex flex-col gap-1">
            <label className="text-xs text-white/50">Instance</label>
            <select
              value={selectedInstance}
              onChange={(e) => { setSelectedInstance(e.target.value); setShowAddForm(false) }}
              className="bg-white/5 border border-white/10 rounded-md px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-white/20"
            >
              <option value="__all__" className="bg-gray-900">All Instances</option>
              {instances.map((inst) => (
                <option key={inst.id} value={inst.id} className="bg-gray-900">{inst.name}</option>
              ))}
            </select>
          </div>

          {/* Allow / Deny tabs */}
          <div className="flex flex-col gap-1">
            <label className="text-xs text-white/50">List</label>
            <div className="flex gap-1">
              {(['allow', 'deny'] as ListType[]).map((t) => (
                <button
                  key={t}
                  onClick={() => { setActiveTab(t); setShowAddForm(false) }}
                  className={cn(
                    'px-4 py-1.5 rounded-md text-sm font-medium transition-colors cursor-pointer capitalize',
                    activeTab === t
                      ? t === 'allow' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'
                      : 'bg-white/5 text-white/50 hover:bg-white/10'
                  )}
                >
                  {t}list
                </button>
              ))}
            </div>
          </div>

          <div className="flex gap-2 ml-auto items-end pb-0.5">
            <Button size="sm" variant="outline" onClick={fetchDomains} disabled={loading}
              className="border-white/10 text-white/70 hover:text-white gap-1.5">
              <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
              Refresh
            </Button>
            <Button size="sm" onClick={() => setShowAddForm((v) => !v)} className="gap-1.5">
              <Plus className="h-3.5 w-3.5" />
              Add Domain
            </Button>
          </div>
        </div>
      </div>

      {/* Add Domain Form */}
      {showAddForm && (
        <div className="glass-card p-4 space-y-4">
          <h3 className="text-sm font-medium text-white/70">
            Add to {activeTab}list
          </h3>

          <div className="flex flex-wrap gap-3 items-start">
            {/* Domain */}
            <div className="flex flex-col gap-1">
              <label className="text-xs text-white/50">Domain *</label>
              <input
                type="text"
                value={newDomain}
                onChange={(e) => setNewDomain(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
                placeholder="e.g. ads.example.com"
                className="bg-white/5 border border-white/10 rounded-md px-3 py-1.5 text-sm text-white placeholder:text-white/20 focus:outline-none focus:ring-1 focus:ring-white/20 w-56"
                autoFocus
              />
            </div>

            {/* Kind */}
            <div className="flex flex-col gap-1">
              <label className="text-xs text-white/50">Type</label>
              <div className="flex gap-1">
                {(['exact', 'regex'] as const).map((k) => (
                  <button
                    key={k}
                    onClick={() => setNewKind(k)}
                    className={cn(
                      'px-3 py-1.5 rounded-md text-sm capitalize transition-colors cursor-pointer',
                      newKind === k ? 'bg-white/15 text-white' : 'bg-white/5 text-white/50 hover:bg-white/10'
                    )}
                  >
                    {k}
                  </button>
                ))}
              </div>
            </div>

            {/* Comment */}
            <div className="flex flex-col gap-1">
              <label className="text-xs text-white/50">Comment</label>
              <input
                type="text"
                value={newComment}
                onChange={(e) => setNewComment(e.target.value)}
                placeholder="Optional note"
                className="bg-white/5 border border-white/10 rounded-md px-3 py-1.5 text-sm text-white placeholder:text-white/20 focus:outline-none focus:ring-1 focus:ring-white/20 w-44"
              />
            </div>

            {/* Enabled */}
            <div className="flex flex-col gap-1">
              <label className="text-xs text-white/50">Enabled</label>
              <div className="flex items-center h-[34px]">
                <Switch checked={newEnabled} onCheckedChange={setNewEnabled} />
              </div>
            </div>

            {/* Groups */}
            {showGroupSelector && (
              <div className="flex flex-col gap-1">
                <label className="text-xs text-white/50">Groups</label>
                <div className="flex flex-wrap gap-1">
                  {groups.map((g) => (
                    <button
                      key={g.id}
                      onClick={() => toggleGroup(g.id)}
                      className={cn(
                        'px-2.5 py-1 rounded text-xs transition-colors cursor-pointer',
                        newGroups.includes(g.id)
                          ? 'bg-blue-500/20 text-blue-300'
                          : 'bg-white/5 text-white/40 hover:bg-white/10'
                      )}
                    >
                      {g.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Instance checkboxes (All view only) */}
          {isAllInstances && (
            <div className="flex flex-col gap-1.5">
              <label className="text-xs text-white/50">Add to instances</label>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() =>
                    setTargetInstances(
                      targetInstances.length === instances.length ? [] : instances.map((i) => i.id)
                    )
                  }
                  className="px-2.5 py-1 rounded text-xs bg-white/10 text-white/60 hover:bg-white/15 cursor-pointer transition-colors"
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
                        ? 'bg-blue-500/20 text-blue-300'
                        : 'bg-white/5 text-white/40 hover:bg-white/10'
                    )}
                  >
                    {inst.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="flex gap-2">
            <Button size="sm" onClick={handleAdd} disabled={adding || !newDomain.trim()}>
              {adding ? 'Adding...' : 'Add'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setShowAddForm(false)}
              className="text-white/50 hover:text-white">
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* Domain table */}
      <div className="glass-card overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-white/30 text-sm animate-pulse">Loading domains...</div>
        ) : domains.length === 0 ? (
          <div className="p-8 text-center text-white/30 text-sm">
            No domains in {activeTab}list
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/5">
                  {isAllInstances && (
                    <th className="text-left px-4 py-3 text-white/40 font-medium whitespace-nowrap">Instance</th>
                  )}
                  <th className="text-left px-4 py-3 text-white/40 font-medium">Domain</th>
                  <th className="text-left px-4 py-3 text-white/40 font-medium whitespace-nowrap">Type</th>
                  <th className="text-left px-4 py-3 text-white/40 font-medium">Comment</th>
                  <th className="text-left px-4 py-3 text-white/40 font-medium whitespace-nowrap">Status</th>
                  <th className="text-left px-4 py-3 text-white/40 font-medium">Groups</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {domains.map((d, i) => (
                  <tr
                    key={`${d.id}-${d.instanceId ?? ''}-${i}`}
                    className="border-b border-white/5 hover:bg-white/3 transition-colors"
                  >
                    {isAllInstances && (
                      <td className="px-4 py-2.5">
                        <span className="inline-block px-2 py-0.5 rounded text-xs bg-white/8 text-white/60 whitespace-nowrap">
                          {d.instanceName ?? d.instanceId ?? '—'}
                        </span>
                      </td>
                    )}
                    <td className="px-4 py-2.5 text-white font-mono text-xs">{d.domain}</td>
                    <td className="px-4 py-2.5">
                      <span className={cn(
                        'inline-block px-2 py-0.5 rounded text-xs font-medium',
                        d.kind === 'regex'
                          ? 'bg-purple-500/15 text-purple-400'
                          : 'bg-white/8 text-white/50'
                      )}>
                        {d.kind}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-white/40 text-xs max-w-[12rem] truncate">
                      {d.comment || '—'}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={cn(
                        'inline-flex items-center gap-1.5 text-xs',
                        d.enabled ? 'text-green-400' : 'text-white/30'
                      )}>
                        <span className={cn(
                          'h-1.5 w-1.5 rounded-full',
                          d.enabled ? 'bg-green-400' : 'bg-white/20'
                        )} />
                        {d.enabled ? 'enabled' : 'disabled'}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-white/40 text-xs">
                      {d.groups?.join(', ') ?? '—'}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <button
                        onClick={() => handleDelete(d)}
                        className="p-1 rounded text-white/30 hover:text-red-400 hover:bg-red-500/10 transition-colors cursor-pointer"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
