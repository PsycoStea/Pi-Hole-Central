import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth-guard'
import { withApiError } from '@/lib/api/with-error'
import { auditedNodeCall } from '@/lib/audit'
import { db } from '@/lib/db'
import { instances } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import * as piholeClient from '@/lib/pihole/client'

export const dynamic = 'force-dynamic'

// Restore a Teleporter zip into a node (destructive — overwrites its config).
export const POST = withApiError(
  async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const denied = await requireAdmin()
    if (denied) return denied
    const { id } = await params
    const inst = await db.query.instances.findFirst({ where: eq(instances.id, id) })
    if (!inst) return NextResponse.json({ error: 'Instance not found' }, { status: 404 })

    const form = await req.formData()
    const file = form.get('file')
    if (!(file instanceof Blob)) {
      return NextResponse.json({ error: 'file (zip) is required' }, { status: 400 })
    }
    const filename = (file as File).name || 'restore.zip'
    const buf = Buffer.from(await file.arrayBuffer())
    if (buf.length === 0) return NextResponse.json({ error: 'file is empty' }, { status: 400 })

    await auditedNodeCall('config.restore', id, filename, () => piholeClient.teleporterImport(id, buf, filename))
    return NextResponse.json({ ok: true })
  }
)
