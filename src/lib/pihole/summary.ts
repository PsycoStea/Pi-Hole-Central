import type { instances } from '@/lib/db/schema'
import * as piholeClient from './client'
import type { PiHoleSummary, BlockingStatus } from './types'

export type InstanceSummary = {
  id: string
  name: string
  url: string
  sshUsername: string | null
  status: 'online' | 'offline'
  summary: PiHoleSummary | null
  blocking: BlockingStatus | null
}

/**
 * Summary + blocking state for one instance. Fetched in parallel, and only a
 * failed SUMMARY makes the node "offline" — a node that answered the summary
 * but not the blocking call used to be shown offline as well.
 */
export async function fetchInstanceSummary(inst: typeof instances.$inferSelect): Promise<InstanceSummary> {
  const [summary, blocking] = await Promise.allSettled([
    piholeClient.getSummary(inst.id),
    piholeClient.getBlockingStatus(inst.id),
  ])
  const online = summary.status === 'fulfilled'
  return {
    id: inst.id,
    name: inst.name,
    url: inst.url,
    sshUsername: inst.sshUsername,
    status: online ? 'online' : 'offline',
    summary: online ? summary.value : null,
    blocking: online && blocking.status === 'fulfilled' ? blocking.value : null,
  }
}

/**
 * Fleet totals. The block percentage is total blocked / total queries, not the
 * mean of each node's percentage: with 10,000 queries at 5% on one node and 100
 * at 50% on the other, the old average showed 27.5% instead of the true 5.4%.
 */
export function aggregate(data: InstanceSummary[], instancesTotal: number) {
  const online = data.filter((i) => i.status === 'online' && i.summary)
  const totalQueries = online.reduce((s, i) => s + (i.summary?.queries.total ?? 0), 0)
  const totalBlocked = online.reduce((s, i) => s + (i.summary?.queries.blocked ?? 0), 0)
  return {
    totalQueries,
    totalBlocked,
    blockPct: totalQueries ? (totalBlocked / totalQueries) * 100 : 0,
    instancesOnline: online.length,
    instancesTotal,
  }
}
