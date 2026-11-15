import { isAllowedInstanceUrl } from '@/lib/pihole/validate'
import * as piholeClient from '@/lib/pihole/client'
import { NextResponse } from 'next/server'
import { resolveLiveConditions } from '@/lib/notifications/center'
import { clearRecoveryState } from '@/lib/ssh/recovery'
import { auth } from '@/lib/auth'
import { requireAdmin } from '@/lib/auth-guard'
import { db } from '@/lib/db'
import { instances, backupHistory } from '@/lib/db/schema'
import { backupPath } from '@/lib/backup/service'
import { errMsg } from '@/lib/errors'
import { extractHost } from '@/lib/ssh/client'
import { promises as fs } from 'fs'
import { eq } from 'drizzle-orm'
import { encrypt } from '@/lib/crypto'
import { logAudit } from '@/lib/audit'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params
  const instance = await db.query.instances.findFirst({ where: eq(instances.id, id) })
  if (!instance) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const { passwordEncrypted: _, sshPasswordEncrypted: __, ...safe } = instance
  return NextResponse.json(safe)
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireAdmin()
  if (denied) return denied
  const { id } = await params
  const body = await req.json()
  const current = await db.query.instances.findFirst({ where: eq(instances.id, id) })
  if (!current) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const update: Partial<typeof instances.$inferInsert> = {}
  if (body.name) update.name = body.name
  if (body.url) {
    const url = String(body.url).replace(/\/$/, '')
    if (!isAllowedInstanceUrl(url)) {
      return NextResponse.json({ error: 'url must be http(s) on a private/LAN address or hostname' }, { status: 400 })
    }
    // Changing where the app connects while keeping the stored password would
    // send that password to the new host on the next poll. Require it again.
    if (url !== current.url && !body.password) {
      return NextResponse.json({ error: 'Re-enter the Pi-hole password when changing the URL' }, { status: 400 })
    }
    update.url = url
  }
  if (body.password) update.passwordEncrypted = encrypt(body.password)
  if (typeof body.enabled === 'boolean') update.enabled = body.enabled
  if ('sshUsername' in body) update.sshUsername = (body.sshUsername as string) || null
  if (body.sshPassword) update.sshPasswordEncrypted = encrypt(body.sshPassword as string)
  if (body.clearSshPassword) update.sshPasswordEncrypted = null
  // A new HOST also must not inherit the stored SSH password (R2-F2): the
  // next recovery/health check would log in to the new host with it. Compare
  // hostnames only, so switching the same node from http:// to https:// keeps it.
  let sshPasswordCleared = false
  if (
    update.url &&
    extractHost(update.url) !== extractHost(current.url) &&
    current.sshPasswordEncrypted &&
    !body.sshPassword
  ) {
    update.sshPasswordEncrypted = null
    sshPasswordCleared = true
  }
  await db.update(instances).set(update).where(eq(instances.id, id))
  if (update.url || update.passwordEncrypted || update.enabled === false) {
    // Release the old session (on the old host) so the next request re-auths.
    await piholeClient.evictSession(id, current.url)
  }
  if (update.enabled === false) {
    // A disabled instance is never polled again, so nothing would resolve its
    // live conditions or clear its recovery state.
    await resolveLiveConditions({ instanceId: id })
    clearRecoveryState(id)
  }
  await logAudit(
    'instance.update',
    id,
    Object.keys(update).join(', ') +
      (update.url && update.url !== current.url ? `; url ${current.url} -> ${update.url}` : '') +
      (sshPasswordCleared ? '; stored SSH password cleared (new host)' : '')
  )
  return NextResponse.json({ ok: true, ...(sshPasswordCleared && { sshPasswordCleared: true }) })
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireAdmin()
  if (denied) return denied
  const { id } = await params
  const current = await db.query.instances.findFirst({ where: eq(instances.id, id) })
  if (current) await piholeClient.evictSession(id, current.url)
  // Resolve first: the FK nulls notifications.instanceId on delete, which would
  // leave the instance's live rows orphaned and permanently unresolvable.
  await resolveLiveConditions({ instanceId: id })
  clearRecoveryState(id)
  // The FK cascade drops this instance's backup_history rows, but not the zip
  // files they name (R3B-F1): full Teleporter exports, incl. the node's
  // password hash, left on disk with nothing in the UI to find or delete them.
  // Rows go first (one delete), then the files; a file that cannot be removed
  // is logged, not fatal.
  const backupFiles = (
    await db.query.backupHistory.findMany({ where: eq(backupHistory.instanceId, id), columns: { filename: true } })
  )
    .map((r) => r.filename)
    .filter(Boolean)
  await db.delete(instances).where(eq(instances.id, id))
  let removed = 0
  for (const f of backupFiles) {
    try {
      await fs.rm(backupPath(f), { force: true })
      removed++
    } catch (err) {
      console.error(`[instances] could not remove backup ${f}: ${errMsg(err)}`)
    }
  }
  await logAudit('instance.remove', id, `${current?.name ?? ''}; ${removed}/${backupFiles.length} backup file(s) removed`)
  return NextResponse.json({ ok: true })
}
