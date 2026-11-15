import { isGroupIds } from '@/lib/pihole/validate'
import { auditedNodeCall } from '@/lib/audit'
import { requireAdmin } from '@/lib/auth-guard'
import { guardReplicaWrite } from '@/lib/nebula/primary'
import * as piholeClient from '@/lib/pihole/client'
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string; listId: string }> }
) {
  const denied = await requireAdmin()
  if (denied) return denied

  const { id } = await params
  const replica = await guardReplicaWrite(id)
  if (replica) return replica
  // The list is identified by its address (body); the [listId] segment is the
  // UI's numeric id and is not what v6 keys lists by.
  const { address, comment = '', enabled = true, groups = [0] } = await req.json()

  if (typeof address !== 'string' || !address.trim()) {
    return NextResponse.json({ error: 'address is required' }, { status: 400 })
  }
  if (!isGroupIds(groups)) {
    return NextResponse.json({ error: 'groups must be a non-empty array of group ids' }, { status: 400 })
  }
  if (typeof enabled !== 'boolean') {
    return NextResponse.json({ error: 'enabled must be a boolean' }, { status: 400 })
  }

  try {
    await auditedNodeCall('adlist.update', id, `${address.trim()} enabled=${enabled} groups=${groups.join(',')}`, () => piholeClient.updateList(id, address.trim(), comment, enabled, groups))
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 })
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string; listId: string }> }
) {
  const denied = await requireAdmin()
  if (denied) return denied

  const { id, listId } = await params
  const replica = await guardReplicaWrite(id)
  if (replica) return replica

  try {
    // Pi-Hole v6 DELETE uses URL-encoded address in path, not numeric ID
    // Next has usually decoded the segment already; decoding again is only
    // needed if it arrives still encoded, and must not throw on a literal "%".
    let address = listId
    if (/%[0-9A-Fa-f]{2}/.test(listId)) {
      try { address = decodeURIComponent(listId) } catch { /* keep as-is */ }
    }
    await auditedNodeCall('adlist.remove', id, address, () => piholeClient.removeList(id, address))
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 })
  }
}
