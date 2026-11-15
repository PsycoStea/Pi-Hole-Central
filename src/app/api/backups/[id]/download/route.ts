import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth-guard'
import { withApiError } from '@/lib/api/with-error'
import { db } from '@/lib/db'
import { backupHistory } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { backupPath } from '@/lib/backup/service'
import { promises as fs } from 'fs'

export const dynamic = 'force-dynamic'

export const GET = withApiError(
  async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const denied = await requireAdmin()
    if (denied) return denied
    const { id } = await params
    const row = await db.query.backupHistory.findFirst({ where: eq(backupHistory.id, id) })
    if (!row || !row.filename) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    let data: Buffer
    try {
      data = await fs.readFile(backupPath(row.filename))
    } catch {
      return NextResponse.json({ error: 'Backup file missing on disk' }, { status: 404 })
    }
    return new NextResponse(new Uint8Array(data), {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${row.filename}"`,
        'Content-Length': String(data.length),
        // A full node config incl. its password hash: never cache it, in the
        // browser or in NPM (R3B-NV1).
        'Cache-Control': 'private, no-store',
      },
    })
  }
)
