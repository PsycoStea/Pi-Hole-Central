import { acquireNodeLock, busyMessage, getActiveNodeLock, releaseNodeLock } from '@/lib/ops/node-lock'
import { db } from '@/lib/db'
import { backupHistory, appSettings, instances } from '@/lib/db/schema'
import { and, eq, desc } from 'drizzle-orm'
import { errMsg } from '@/lib/errors'
import * as piholeClient from '@/lib/pihole/client'
import { globalSingleton } from '@/lib/global-state'
import { randomUUID } from 'crypto'
import { checkTeleporterZip } from './zip-check'
import { promises as fs } from 'fs'
import path from 'path'

const DEFAULT_RETENTION = 14

// Store backups alongside the SQLite DB (same persistent volume).
export function backupDir(): string {
  const dbPath = process.env.DATABASE_URL?.replace('file:', '') ?? './data/pihole-central.db'
  return path.join(path.dirname(dbPath), 'backups')
}

export function backupPath(filename: string): string {
  return path.join(backupDir(), path.basename(filename)) // basename guards against path traversal
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 40)
}

// Retry a flaky async op (e.g. a Teleporter export that hits a transient
// "fetch failed"/timeout on the slower Pi Zero 2W node) before giving up.
export async function withRetry<T>(
  fn: () => Promise<T>,
  attempts = 3,
  delayMs = 2000
): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (i < attempts - 1) {
        console.warn(`[backup] export attempt ${i + 1}/${attempts} failed, retrying:`, err instanceof Error ? err.message : err)
        await new Promise((r) => setTimeout(r, delayMs))
      }
    }
  }
  throw lastErr
}

async function getSetting(key: string, fallback: string): Promise<string> {
  const row = await db.query.appSettings.findFirst({ where: eq(appSettings.key, key) })
  return row?.value ?? fallback
}

type InstanceRow = typeof instances.$inferSelect

async function fireWebhook(payload: Record<string, unknown>): Promise<void> {
  const url = (await getSetting('backup_webhook_url', '')).trim()
  if (!url) return
  const token = (await getSetting('backup_webhook_token', '')).trim()
  try {
    await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'X-Webhook-Token': token } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
      // fetch re-sends custom headers (X-Webhook-Token) to a redirect target,
      // even on another host (R3A-NV1). A webhook has no reason to redirect.
      redirect: 'error',
    })
  } catch (err) {
    console.error(`[backup] webhook post failed: ${errMsg(err)}`)
  }
}

// Failed attempts are kept for diagnosis but never count toward "keep last N".
const FAILURE_KEEP = 20
const FAILURE_MAX_AGE_MS = 30 * 86_400_000

async function prune(instanceId: string): Promise<void> {
  const keep = Math.max(1, parseInt(await getSetting('backup_retention_count', String(DEFAULT_RETENTION)), 10) || DEFAULT_RETENTION)
  const rows = await db.query.backupHistory.findMany({
    where: eq(backupHistory.instanceId, instanceId),
    orderBy: desc(backupHistory.createdAt),
  })
  // "Keep last N" means N good backups. Counting failure rows too meant a
  // node that was down for a while had its failures push every good zip out.
  const successes = rows.filter((r) => r.success)
  const failures = rows.filter((r) => !r.success)
  const cutoff = Date.now() - FAILURE_MAX_AGE_MS
  const stale = [
    ...successes.slice(keep),
    ...failures.filter((r, i) => i >= FAILURE_KEEP || r.createdAt.getTime() < cutoff),
  ]
  for (const r of stale) {
    if (r.filename) await fs.rm(backupPath(r.filename), { force: true }).catch(() => {})
    await db.delete(backupHistory).where(eq(backupHistory.id, r.id)).catch(() => {})
  }
}

export async function runBackup(
  instance: InstanceRow,
  trigger: 'manual' | 'scheduled'
): Promise<{ ok: boolean; filename?: string; error?: string }> {
  const id = randomUUID()
  let filename = ''
  let rowInserted = false
  // Not during an update, recovery or gravity run of this node (P5.2): the
  // export is slow on the Pi Zero and must not overlap an FTL restart.
  const lock = await acquireNodeLock(instance.id, 'teleporter')
  try {
    if (!lock) {
      const held = await getActiveNodeLock(instance.id)
      throw new Error(held ? busyMessage(held.kind, instance.name) : `${instance.name} is busy`)
    }
    const buf = await withRetry(() => piholeClient.teleporterExport(instance.id))
    // Any 2xx body used to be stored as a good backup and then rotate a real
    // one out (R3B-F2). Only a zip with the expected entries counts.
    const invalid = checkTeleporterZip(buf)
    if (invalid) throw new Error(`Export is not a valid Teleporter zip (${invalid})`)
    await fs.mkdir(backupDir(), { recursive: true, mode: 0o700 })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    filename = `${sanitize(instance.name)}-${instance.id.slice(0, 8)}-${stamp}.zip`

    // Row first, marked not-yet-successful, so a file on disk always has a row
    // that prune / delete / instance removal can find (R3B-F3: the zip was
    // written before the insert and stayed orphaned when the insert failed).
    await db.insert(backupHistory).values({
      id,
      instanceId: instance.id,
      filename,
      sizeBytes: buf.length,
      trigger,
      success: false,
      note: 'writing',
      createdAt: new Date(),
    })
    rowInserted = true
    await fs.writeFile(backupPath(filename), buf, { mode: 0o600 })
    await db.update(backupHistory).set({ success: true, note: '' }).where(eq(backupHistory.id, id))
    await prune(instance.id)
    await fireWebhook({
      event: 'backup.completed',
      instanceId: instance.id,
      instanceName: instance.name,
      filename,
      sizeBytes: buf.length,
      trigger,
      success: true,
      timestamp: new Date().toISOString(),
    })
    return { ok: true, filename }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'backup failed'
    console.error(`[backup] failed for ${instance.name}:`, message)
    if (filename) await fs.rm(backupPath(filename), { force: true }).catch(() => {})
    const failed = { filename: '', sizeBytes: 0, success: false, note: message.slice(0, 300) }
    if (rowInserted) {
      await db.update(backupHistory).set(failed).where(eq(backupHistory.id, id)).catch(() => {})
    } else {
      await db
        .insert(backupHistory)
        .values({ id, instanceId: instance.id, trigger, createdAt: new Date(), ...failed })
        .catch(() => {})
    }
    // Keeps the failure rows bounded; never removes a good backup (prune
    // counts only successes towards "keep last N").
    await prune(instance.id).catch(() => {})
    await fireWebhook({
      event: 'backup.failed',
      instanceId: instance.id,
      instanceName: instance.name,
      trigger,
      success: false,
      error: message,
      timestamp: new Date().toISOString(),
    })
    return { ok: false, error: message }
  } finally {
    await releaseNodeLock(lock)
  }
}

// Self-gated scheduled backups (off | daily | weekly). Called from the poll worker.
//
// "Due" is decided per instance from backup_history, not from an in-memory
// clock: the old clock started at 0, so every container start (each deploy)
// ran a scheduled backup — with retention 2, two deploys in a day rotated out
// every older restore point. A failed run is retried, but at most hourly.
const RETRY_FAILED_MS = 3_600_000
const backupState = globalSingleton('__piholeCentralBackupState', () => ({
  running: false,
  lastAttempt: new Map<string, number>(),
}))

async function lastScheduledSuccess(instanceId: string): Promise<number> {
  const row = await db.query.backupHistory.findFirst({
    where: and(
      eq(backupHistory.instanceId, instanceId),
      eq(backupHistory.trigger, 'scheduled'),
      eq(backupHistory.success, true)
    ),
    orderBy: desc(backupHistory.createdAt),
  })
  return row?.createdAt.getTime() ?? 0
}

export async function runScheduledBackups(): Promise<void> {
  if (backupState.running) return
  const interval = await getSetting('backup_interval', 'off')
  const intervalMs: Record<string, number> = { daily: 86_400_000, weekly: 604_800_000 }
  const ms = intervalMs[interval]
  if (!ms) return // 'off' or unknown

  backupState.running = true
  try {
    const active = await db.query.instances.findMany({ where: eq(instances.enabled, true) })
    for (const inst of active) {
      const now = Date.now()
      if (now - (await lastScheduledSuccess(inst.id)) < ms) continue
      if (now - (backupState.lastAttempt.get(inst.id) ?? 0) < RETRY_FAILED_MS) continue
      backupState.lastAttempt.set(inst.id, now)
      await runBackup(inst, 'scheduled').catch((err) => console.error(`[backup] scheduled error: ${errMsg(err)}`))
    }
  } finally {
    backupState.running = false
  }
}
