import { db } from '@/lib/db'
import { alertSettings, instances, statsSnapshots } from '@/lib/db/schema'
import { eq, desc } from 'drizzle-orm'
import { dispatch } from '@/lib/notifications'
import type { PiHoleSummary } from '@/lib/pihole/types'

// Track last alert time per instance+type to avoid spamming (1h cooldown)
const lastAlerted = new Map<string, number>()

function shouldAlert(key: string): boolean {
  const last = lastAlerted.get(key) ?? 0
  if (Date.now() - last > 3_600_000) {
    lastAlerted.set(key, Date.now())
    return true
  }
  return false
}

export async function checkAlerts(
  instance: typeof instances.$inferSelect,
  summary: PiHoleSummary | null,
  currentStatus: 'online' | 'offline'
) {
  const settings = await db.query.alertSettings.findMany({
    where: eq(alertSettings.enabled, true),
  })

  const previousSnapshot = await db.query.statsSnapshots.findFirst({
    where: eq(statsSnapshots.instanceId, instance.id),
    orderBy: desc(statsSnapshots.timestamp),
    offset: 1,
  })
  const previousStatus = previousSnapshot?.status ?? 'online'

  for (const setting of settings) {
    const channelIds: string[] = JSON.parse(setting.channelIdsJson)
    if (!channelIds.length) continue

    const key = `${instance.id}:${setting.type}`

    switch (setting.type) {
      case 'offline':
        if (currentStatus === 'offline' && previousStatus === 'online' && shouldAlert(key)) {
          await dispatch(
            `Pi-Hole Offline: ${instance.name}`,
            `${instance.name} (${instance.url}) is not responding.`,
            channelIds
          )
        }
        break

      case 'recovery':
        if (currentStatus === 'online' && previousStatus === 'offline' && shouldAlert(key)) {
          await dispatch(
            `Pi-Hole Recovered: ${instance.name}`,
            `${instance.name} (${instance.url}) is back online.`,
            channelIds
          )
        }
        break

      case 'blocking_disabled':
        if (
          currentStatus === 'online' &&
          summary?.blocking !== 'enabled' &&
          shouldAlert(key)
        ) {
          await dispatch(
            `Blocking Disabled: ${instance.name}`,
            `Ad blocking is currently disabled on ${instance.name} (${instance.url}).`,
            channelIds
          )
        }
        break

      case 'block_rate_low':
        if (
          currentStatus === 'online' &&
          summary &&
          setting.threshold !== null &&
          summary.queries.percent_blocked < (setting.threshold ?? 5) &&
          shouldAlert(key)
        ) {
          await dispatch(
            `Low Block Rate: ${instance.name}`,
            `Block rate on ${instance.name} is ${summary.queries.percent_blocked.toFixed(1)}% — below threshold of ${setting.threshold}%.`,
            channelIds
          )
        }
        break
    }
  }
}
