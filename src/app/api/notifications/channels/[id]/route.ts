import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth-guard'
import { db } from '@/lib/db'
import { notificationChannels } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { encrypt, decrypt } from '@/lib/crypto'
import { logAudit } from '@/lib/audit'
import { diffChannelConfig } from '@/lib/notifications/describe'

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireAdmin()
  if (denied) return denied
  const { id } = await params
  const body = await req.json()
  const update: Partial<typeof notificationChannels.$inferInsert> = {}
  if (body.label) update.label = body.label
  if (body.config) update.configJson = encrypt(JSON.stringify(body.config))
  if (typeof body.enabled === 'boolean') update.enabled = body.enabled
  if (Object.keys(update).length === 0) return NextResponse.json({ ok: true })
  const old = await db.query.notificationChannels.findFirst({ where: eq(notificationChannels.id, id) })
  await db.update(notificationChannels).set(update).where(eq(notificationChannels.id, id))
  const changes: string[] = []
  if (update.label !== undefined && update.label !== old?.label) changes.push(`label: ${JSON.stringify(old?.label ?? '')} -> ${JSON.stringify(update.label)}`)
  if (update.enabled !== undefined && update.enabled !== old?.enabled) changes.push(`enabled=${update.enabled}`)
  if (body.config) {
    let before: Record<string, unknown> = {}
    try {
      before = old ? JSON.parse(decrypt(old.configJson)) : {}
    } catch {
      /* unreadable old config: report every field as changed */
    }
    const d = diffChannelConfig(before, body.config)
    if (d) changes.push(d)
  }
  await logAudit('channel.update', id, `${old?.type ?? '?'} "${old?.label ?? ''}": ${changes.join('; ') || 'no change'}`)
  return NextResponse.json({ ok: true })
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireAdmin()
  if (denied) return denied
  const { id } = await params
  const old = await db.query.notificationChannels.findFirst({ where: eq(notificationChannels.id, id) })
  await db.delete(notificationChannels).where(eq(notificationChannels.id, id))
  await logAudit('channel.remove', id, old ? `${old.type} "${old.label}"` : '')
  return NextResponse.json({ ok: true })
}
