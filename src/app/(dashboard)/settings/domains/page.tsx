'use client'

import { useEffect, useState, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Trash2, Plus } from 'lucide-react'
import { toast } from 'sonner'

interface Instance { id: string; name: string }
interface Domain { domain: string; kind: string; comment: string; id: number }

export default function DomainsPage() {
  const [instances, setInstances] = useState<Instance[]>([])
  const [selectedInstance, setSelectedInstance] = useState<string>('')
  const [allowList, setAllowList] = useState<Domain[]>([])
  const [denyList, setDenyList] = useState<Domain[]>([])
  const [activeTab, setActiveTab] = useState<'allow' | 'deny'>('allow')
  const [newDomain, setNewDomain] = useState('')
  const [loading, setLoading] = useState(false)
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    fetch('/api/stats/summary')
      .then((r) => r.json())
      .then((data) => {
        const insts: Instance[] = (data.instances ?? []).map((i: { id: string; name: string }) => ({ id: i.id, name: i.name }))
        setInstances(insts)
        if (insts.length > 0) setSelectedInstance(insts[0].id)
      })
      .catch(() => {})
  }, [])

  const fetchList = useCallback(async (list: 'allow' | 'deny') => {
    if (!selectedInstance) return
    setLoading(true)
    try {
      const res = await fetch(`/api/pihole/${selectedInstance}/domains?list=${list}`)
      if (res.ok) {
        const { domains } = await res.json()
        if (list === 'allow') setAllowList(domains ?? [])
        else setDenyList(domains ?? [])
      }
    } catch {
      toast.error(`Failed to load ${list}list`)
    } finally {
      setLoading(false)
    }
  }, [selectedInstance])

  useEffect(() => {
    if (selectedInstance) {
      fetchList('allow')
      fetchList('deny')
    }
  }, [selectedInstance, fetchList])

  async function handleAdd() {
    const domain = newDomain.trim()
    if (!domain || !selectedInstance) return
    setAdding(true)
    try {
      const res = await fetch(`/api/pihole/${selectedInstance}/domains`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain, list: activeTab }),
      })
      if (res.ok) {
        toast.success(`Added "${domain}" to ${activeTab}list`)
        setNewDomain('')
        fetchList(activeTab)
      } else {
        const { error } = await res.json()
        toast.error(error ?? 'Failed to add domain')
      }
    } catch {
      toast.error('Failed to add domain')
    } finally {
      setAdding(false)
    }
  }

  async function handleDelete(domain: string, list: 'allow' | 'deny') {
    try {
      const res = await fetch(`/api/pihole/${selectedInstance}/domains`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain, list }),
      })
      if (res.ok) {
        toast.success(`Removed "${domain}" from ${list}list`)
        fetchList(list)
      } else {
        toast.error('Failed to remove domain')
      }
    } catch {
      toast.error('Failed to remove domain')
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Domain Lists</h1>
        <p className="text-sm text-white/40 mt-0.5">Manage allowlists and denylists per instance</p>
      </div>

      {/* Instance selector */}
      <div className="flex items-center gap-3">
        <label className="text-sm text-white/50">Instance</label>
        <select
          value={selectedInstance}
          onChange={(e) => setSelectedInstance(e.target.value)}
          className="bg-white/5 border border-white/10 rounded-md px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-white/20"
        >
          {instances.map((inst) => (
            <option key={inst.id} value={inst.id} className="bg-gray-900">{inst.name}</option>
          ))}
        </select>
      </div>

      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'allow' | 'deny')}>
        <TabsList className="bg-white/5 border border-white/10">
          <TabsTrigger value="allow">Allowlist ({allowList.length})</TabsTrigger>
          <TabsTrigger value="deny">Denylist ({denyList.length})</TabsTrigger>
        </TabsList>

        {(['allow', 'deny'] as const).map((list) => (
          <TabsContent key={list} value={list} className="mt-4 space-y-4">
            {/* Add domain */}
            <div className="flex gap-2">
              <input
                type="text"
                value={newDomain}
                onChange={(e) => setNewDomain(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
                placeholder="e.g. ads.example.com"
                className="flex-1 bg-white/5 border border-white/10 rounded-md px-3 py-2 text-sm text-white placeholder:text-white/20 focus:outline-none focus:ring-1 focus:ring-white/20"
              />
              <Button size="sm" onClick={handleAdd} disabled={adding || !newDomain.trim()}>
                <Plus className="h-4 w-4 mr-1.5" />
                Add
              </Button>
            </div>

            {/* Domain table */}
            <div className="glass-card overflow-hidden">
              {loading ? (
                <div className="p-8 text-center text-white/30 text-sm animate-pulse">Loading...</div>
              ) : (list === 'allow' ? allowList : denyList).length === 0 ? (
                <div className="p-8 text-center text-white/30 text-sm">No domains in {list}list</div>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-white/5">
                      <th className="text-left px-4 py-3 text-white/40 font-medium">Domain</th>
                      <th className="text-left px-4 py-3 text-white/40 font-medium">Type</th>
                      <th className="text-left px-4 py-3 text-white/40 font-medium">Comment</th>
                      <th className="w-12 px-4 py-3" />
                    </tr>
                  </thead>
                  <tbody>
                    {(list === 'allow' ? allowList : denyList).map((d) => (
                      <tr key={d.id} className="border-b border-white/5 hover:bg-white/3 transition-colors">
                        <td className="px-4 py-2.5 text-white font-mono text-xs">{d.domain}</td>
                        <td className="px-4 py-2.5 text-white/50 capitalize">{d.kind}</td>
                        <td className="px-4 py-2.5 text-white/40 text-xs">{d.comment || '—'}</td>
                        <td className="px-4 py-2.5">
                          <button
                            onClick={() => handleDelete(d.domain, list)}
                            className="text-white/30 hover:text-red-400 transition-colors cursor-pointer p-1"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </TabsContent>
        ))}
      </Tabs>
    </div>
  )
}
