import { EventEmitter } from 'node:events'
import { db } from '@/lib/db'
import { instances } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { fetchInstanceSummary, aggregate } from '@/lib/pihole/summary'
import type { PiHoleSummary, BlockingStatus } from '@/lib/pihole/types'

export type LiveData = {
  instances: Array<{
    id: string
    name: string
    url: string
    sshUsername: string | null
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
// One listener per open SSE stream; /api/events caps those at 64 (audit R2-F4),
// so this only has to sit above that cap to keep the warning meaningful.
emitter.setMaxListeners(70)

let latestData: LiveData | null = null
let intervalId: ReturnType<typeof setInterval> | null = null
let subscribers = 0

async function refresh() {
  try {
    const activeInstances = await db.query.instances.findMany({ where: eq(instances.enabled, true) })
    const instanceData = await Promise.all(activeInstances.map(fetchInstanceSummary))
    latestData = { instances: instanceData, aggregated: aggregate(instanceData, activeInstances.length) }
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
