import { enabledInstance } from '@/lib/pihole/instance-guard'
import { isGroupIds, isHttpUrl } from '@/lib/pihole/validate'
import { auditedNodeCall } from '@/lib/audit'
import { auth } from '@/lib/auth'
import { requireAdmin } from '@/lib/auth-guard'
import { guardReplicaWrite } from '@/lib/nebula/primary'
import * as piholeClient from '@/lib/pihole/client'
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  // R2-NV2: a disabled node gets no calls, not even reads.
  const guard = await enabledInstance(id)
  if (guard.denied) return guard.denied

  try {
    const lists = await piholeClient.getLists(id)
    return NextResponse.json({ lists })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 })
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = await requireAdmin()
  if (denied) return denied

  const { id } = await params
  const replica = await guardReplicaWrite(id)
  if (replica) return replica
  const { address, comment = '', enabled = true, groups = [0] } = await req.json()

  if (!isHttpUrl(address)) {
    return NextResponse.json({ error: 'address must be an http(s) URL' }, { status: 400 })
  }
  if (!isGroupIds(groups)) {
    return NextResponse.json({ error: 'groups must be a non-empty array of group ids' }, { status: 400 })
  }

  try {
    await auditedNodeCall('adlist.add', id, address.trim(), () => piholeClient.addList(id, address.trim(), comment, enabled, groups))
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 })
  }
}
