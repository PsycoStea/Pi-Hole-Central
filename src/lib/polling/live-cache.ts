import { EventEmitter } from 'node:events'
import { db } from '@/lib/db'
import { instances } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import * as piholeClient from '@/lib/pihole/client'
import type { PiHoleSummary, BlockingStatus } from '@/lib/pihole/types'

export type LiveData = {
  instances: Array<{
    id: string
    name: string
    status: 'online' | 'offline'
    summary: PiHoleSummary | null
    blocking: BlockingStatus | null
  }>
  aggregated: {
    totalQueries: number
    totalBlocked: number
    blockPct: number
    instancesOnline: number
    instancesTotal: number
  }
}

const emitter = new EventEmitter()
emitter.setMaxListeners(50)

let latestData: LiveData | null = null
let intervalId: ReturnType<typeof setInterval> | null = null
let subscribers = 0

async function refresh() {
  try {
    const activeInstances = await db.query.instances.findMany({ where: eq(instances.enabled, true) })
    const results = await Promise.allSettled(
      activeInstances.map(async (inst) => {
        const [summary, blocking] = await Promise.all([
          piholeClient.getSummary(inst.id),
          piholeClient.getBlockingStatus(inst.id),
        ])
        return { id: inst.id, name: inst.name, status: 'online' as const, summary, blocking }
      })
    )
    const instanceData = results.map((r, i) =>
      r.status === 'fulfilled'
        ? r.value
        : { id: activeInstances[i].id, name: activeInstances[i].name, status: 'offline' as const, summary: null, blocking: null }
    )
    const online = instanceData.filter(i => i.status === 'online' && i.summary)
    latestData = {
      instances: instanceData,
      aggregated: {
        totalQueries: online.reduce((s, i) => s + (i.summary?.queries.total ?? 0), 0),
        totalBlocked: online.reduce((s, i) => s + (i.summary?.queries.blocked ?? 0), 0),
        blockPct: online.length
          ? online.reduce((s, i) => s + (i.summary?.queries.percent_blocked ?? 0), 0) / online.length
          : 0,
        instancesOnline: online.length,
        instancesTotal: activeInstances.length,
      },
    }
    emitter.emit('update', latestData)
  } catch (err) {
    console.error('[live-cache] refresh error:', err)
  }
}

export function getLatestData(): LiveData | null {
  return latestData
}

export function subscribe(callback: (data: LiveData) => void): () => void {
  emitter.on('update', callback)
  subscribers++
  if (subscribers === 1) {
    refresh()
    intervalId = setInterval(refresh, 30_000)
  }
  return () => {
    emitter.off('update', callback)
    subscribers--
    if (subscribers === 0 && intervalId) {
      clearInterval(intervalId)
      intervalId = null
    }
  }
}
