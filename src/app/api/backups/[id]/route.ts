import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth-guard'
import { withApiError } from '@/lib/api/with-error'
import { db } from '@/lib/db'
import { backupHistory } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { backupPath } from '@/lib/backup/service'
import { logAudit } from '@/lib/audit'
import { promises as fs } from 'fs'

export const dynamic = 'force-dynamic'

export const DELETE = withApiError(
  async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const denied = await requireAdmin()
    if (denied) return denied
    const { id } = await params
    const row = await db.query.backupHistory.findFirst({ where: eq(backupHistory.id, id) })
    if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (row.filename) await fs.rm(backupPath(row.filename), { force: true }).catch(() => {})
    await db.delete(backupHistory).where(eq(backupHistory.id, id))
    await logAudit('backup.delete', id, row.filename)
    return NextResponse.json({ ok: true })
  }
)
