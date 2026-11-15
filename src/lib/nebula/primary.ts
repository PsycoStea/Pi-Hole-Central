import { db } from '@/lib/db'
import { appSettings, instances } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'

// nebula-sync copies config (domains, adlists, groups, clients) from ONE primary
// node to the replica(s) on a schedule, as a full overwrite. Anything edited
// directly on a replica is silently undone at the next sync. So config editors
// write to the primary only, and the replicas are read-only here.
//
// Which node is primary is an explicit admin setting (Settings → Sync). It is
// never guessed from creation order or IP: a wrong guess would block every edit
// on the real primary. While it is unset, writes are allowed everywhere (the old
// behaviour) and the editors show a "choose the primary node" banner.
//
// The guard lives in the config-write ROUTES, not in lib/pihole/client.ts, on
// purpose: temp-allow (and its revert at expiry) and Teleporter restore go
// through the same client functions and must keep working on every node.

export const PRIMARY_SETTING_KEY = 'primary_instance_id'

export type PrimaryNode = { id: string; name: string }

/** The configured primary node, or null when unset or pointing at a deleted instance. */
export async function getPrimaryNode(): Promise<PrimaryNode | null> {
  const row = await db.query.appSettings.findFirst({ where: eq(appSettings.key, PRIMARY_SETTING_KEY) })
  const id = (row?.value ?? '').trim()
  if (!id) return null
  const inst = await db.query.instances.findFirst({ where: eq(instances.id, id) })
  return inst ? { id: inst.id, name: inst.name } : null
}

/**
 * Returns a 409 response when `instanceId` is a replica (a primary is set and
 * this is not it), else null. Call after the auth check in every config-write
 * handler: domains, adlists, clients.
 */
export async function guardReplicaWrite(instanceId: string): Promise<NextResponse | null> {
  const primary = await getPrimaryNode()
  if (!primary || primary.id === instanceId) return null
  return NextResponse.json(
    {
      error: `This node is a replica: nebula-sync overwrites its config from ${primary.name}. Make the change on ${primary.name} instead.`,
      code: 'replica_read_only',
      primaryId: primary.id,
      primaryName: primary.name,
    },
    { status: 409 }
  )
}
