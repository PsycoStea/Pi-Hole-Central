import { db } from '@/lib/db'
import { instances, appSettings } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import * as piholeClient from '@/lib/pihole/client'
import { globalSingleton } from '@/lib/global-state'

// globalThis-anchored so the check interval is honored process-wide (not reset
// per duplicated module chunk).
const versionCheckState = globalSingleton('__piholeCentralVersionCheck', () => ({ lastCheckedAt: 0 }))

export type VersionStatus = Record<string, {
  hasUpdate: boolean
  checkedAt: number
  localCore: string
  remoteCore: string
}>

async function getCheckIntervalMs(): Promise<number> {
  const s = await db.query.appSettings.findFirst({ where: eq(appSettings.key, 'update_check_interval') })
  const intervals: Record<string, number> = { daily: 86400, weekly: 604800, monthly: 2592000 }
  return (intervals[s?.value ?? 'daily'] ?? 86400) * 1000
}

export async function runVersionCheck(): Promise<void> {
  const intervalMs = await getCheckIntervalMs()
  if (Date.now() - versionCheckState.lastCheckedAt < intervalMs) return

  versionCheckState.lastCheckedAt = Date.now()
  const activeInstances = await db.query.instances.findMany({ where: eq(instances.enabled, true) })

  // Start from the previously-stored status so a node that errors this cycle
  // keeps its last-known version info instead of being wiped.
  const existingRow = await db.query.appSettings.findFirst({
    where: eq(appSettings.key, 'version_status'),
  })
  let status: VersionStatus = {}
  if (existingRow?.value) {
    try {
      status = JSON.parse(existingRow.value) as VersionStatus
    } catch {
      status = {}
    }
  }

  for (const instance of activeInstances) {
    try {
      const info = await piholeClient.getInstanceInfo(instance.id)
      const hasUpdate =
        info.version.core.local !== info.version.core.remote ||
        info.version.ftl.local  !== info.version.ftl.remote  ||
        info.version.web.local  !== info.version.web.remote
      status[instance.id] = {
        hasUpdate,
        checkedAt: Date.now(),
        localCore: info.version.core.local,
        remoteCore: info.version.core.remote,
      }
      console.log(`[version-check] ${instance.name}: core ${info.version.core.local} → remote ${info.version.core.remote} | update=${hasUpdate}`)
    } catch (err) {
      console.error(`[version-check] Failed to check ${instance.name}:`, err)
    }
  }

  if (Object.keys(status).length > 0) {
    await db.insert(appSettings)
      .values({ key: 'version_status', value: JSON.stringify(status) })
      .onConflictDoUpdate({ target: appSettings.key, set: { value: JSON.stringify(status) } })
  }
}
