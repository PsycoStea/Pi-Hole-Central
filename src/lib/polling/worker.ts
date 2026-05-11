import cron from 'node-cron'
import { db } from '@/lib/db'
import { instances, statsSnapshots } from '@/lib/db/schema'
import { eq, lt } from 'drizzle-orm'
import * as piholeClient from '@/lib/pihole/client'
import { checkAlerts } from './alerts'

let isRunning = false

export async function pollAllInstances() {
  if (isRunning) return
  isRunning = true
  try {
    const activeInstances = await db.query.instances.findMany({
      where: eq(instances.enabled, true),
    })

    for (const instance of activeInstances) {
      try {
        const [summary, topDomains, topClients] = await Promise.all([
          piholeClient.getSummary(instance.id),
          piholeClient.getTopDomains(instance.id, 10),
          piholeClient.getTopClients(instance.id, 10),
        ])

        await db.insert(statsSnapshots).values({
          instanceId: instance.id,
          timestamp: new Date(),
          queriesToday: summary.queries.total,
          blockedToday: summary.queries.blocked,
          blockPct: summary.queries.percent_blocked,
          uniqueDomains: summary.queries.unique_domains,
          topDomainsJson: JSON.stringify(topDomains),
          topClientsJson: JSON.stringify(topClients),
          status: 'online',
        })

        await checkAlerts(instance, summary, 'online')
      } catch (err) {
        console.error(`[poller] Failed to poll ${instance.name}:`, err)
        await db.insert(statsSnapshots).values({
          instanceId: instance.id,
          timestamp: new Date(),
          queriesToday: 0,
          blockedToday: 0,
          blockPct: 0,
          uniqueDomains: 0,
          topDomainsJson: '[]',
          topClientsJson: '[]',
          status: 'offline',
        })
        await checkAlerts(instance, null, 'offline')
      }
    }

    // Prune snapshots older than 30 days
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    await db.delete(statsSnapshots).where(lt(statsSnapshots.timestamp, cutoff))
  } finally {
    isRunning = false
  }
}

export function startPolling() {
  console.log('[poller] Starting background polling (every 5 minutes)')
  // Poll immediately on start
  pollAllInstances().catch(console.error)
  // Then every 5 minutes
  cron.schedule('*/5 * * * *', () => {
    pollAllInstances().catch(console.error)
  })
}
