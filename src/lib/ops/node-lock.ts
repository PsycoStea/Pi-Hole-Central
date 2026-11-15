import { randomUUID } from 'crypto'
import { and, eq, gt, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { nodeLocks } from '@/lib/db/schema'

/**
 * Per-node operation lock (audit P5.2 / R2-NV3).
 *
 * Before this, an admin-started `pihole -up` set no state at all, so the poller
 * saw the node's API go down mid-update and SSH recovery restarted FTL (and,
 * if the API stayed down, rebooted the node) in the middle of the upgrade.
 * Gravity, Teleporter exports and the CLOSE-WAIT watchdog were just as blind to
 * each other.
 *
 * One row per node in `node_locks`. Every holder sets an expiry, so a crashed
 * holder (container restart mid-update) releases the node by itself.
 *
 * Kinds that restart or reboot FTL ("disruptive") are additionally exclusive
 * ACROSS nodes: never take both Pi-holes' DNS down at once (R2-NV4/NV5). Both
 * rules are checked inside the single INSERT statement, so two watchdog checks
 * fired in the same poll sweep cannot both pass a check-then-take race.
 */
export type LockKind = 'update' | 'gravity' | 'teleporter' | 'recovery' | 'watchdog'

const DISRUPTIVE: readonly LockKind[] = ['recovery', 'watchdog']

/** Longer than the slowest real run of each operation, short enough to self-heal. */
export const LOCK_TTL_MS: Record<LockKind, number> = {
  update: 20 * 60_000, // the update's SSH exec deadline is 15 min
  gravity: 15 * 60_000,
  teleporter: 10 * 60_000,
  recovery: 10 * 60_000, // 3 restarts x (30 s + up to 20 s API wait) + reboot, renewed per step
  watchdog: 3 * 60_000,
}

export const LOCK_LABEL: Record<LockKind, string> = {
  update: 'a Pi-hole update',
  gravity: 'a gravity update',
  teleporter: 'a Teleporter backup',
  recovery: 'automatic recovery',
  watchdog: 'a watchdog restart',
}

export type NodeLock = { instanceId: string; kind: LockKind; token: string }

/** Take the node's lock, or return null if it (or, for a disruptive kind, any other node's disruptive lock) is held. */
export async function acquireNodeLock(
  instanceId: string,
  kind: LockKind,
  ttlMs: number = LOCK_TTL_MS[kind]
): Promise<NodeLock | null> {
  const now = Date.now()
  const token = randomUUID()
  const crossNode = DISRUPTIVE.includes(kind) ? 1 : 0
  let res: { changes: number }
  try {
    res = db.run(sql`
    INSERT INTO node_locks (instance_id, kind, token, started_at, expires_at)
    SELECT ${instanceId}, ${kind}, ${token}, ${now}, ${now + ttlMs}
    WHERE ${crossNode} = 0 OR NOT EXISTS (
      SELECT 1 FROM node_locks
      WHERE instance_id <> ${instanceId} AND kind IN ('recovery', 'watchdog') AND expires_at > ${now}
    )
    ON CONFLICT (instance_id) DO UPDATE SET
      kind = excluded.kind, token = excluded.token,
      started_at = excluded.started_at, expires_at = excluded.expires_at
    WHERE node_locks.expires_at <= ${now}
  `)
  } catch (err) {
    // The instance was deleted (FK): nothing to lock.
    if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_FOREIGNKEY') return null
    throw err
  }
  return res.changes === 1 ? { instanceId, kind, token } : null
}

/** Extend a held lock (long multi-step holders call this between steps). False if it was lost. */
export async function renewNodeLock(lock: NodeLock, ttlMs: number = LOCK_TTL_MS[lock.kind]): Promise<boolean> {
  const res = db.run(sql`
    UPDATE node_locks SET expires_at = ${Date.now() + ttlMs}
    WHERE instance_id = ${lock.instanceId} AND token = ${lock.token}
  `)
  return res.changes === 1
}

/** Release only our own lock (a lock that expired and was re-taken by someone else is left alone). */
export async function releaseNodeLock(lock: NodeLock | null | undefined): Promise<void> {
  if (!lock) return
  await db
    .delete(nodeLocks)
    .where(and(eq(nodeLocks.instanceId, lock.instanceId), eq(nodeLocks.token, lock.token)))
    .catch(() => {})
}

/** The live (unexpired) lock on a node, if any. */
export async function getActiveNodeLock(
  instanceId: string
): Promise<{ kind: LockKind; startedAt: number; expiresAt: number } | null> {
  const row = await db.query.nodeLocks.findFirst({
    where: and(eq(nodeLocks.instanceId, instanceId), gt(nodeLocks.expiresAt, Date.now())),
  })
  return row ? { kind: row.kind as LockKind, startedAt: row.startedAt, expiresAt: row.expiresAt } : null
}

/** 409 body for a route that found the node busy. */
export function busyMessage(kind: LockKind, name: string): string {
  return `${name} is busy with ${LOCK_LABEL[kind]}. Try again when it has finished.`
}
