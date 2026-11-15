import { enabledInstance } from '@/lib/pihole/instance-guard'
import { isGroupIds } from '@/lib/pihole/validate'
import { auditedNodeCall } from '@/lib/audit'
import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { requireAdmin } from '@/lib/auth-guard'
import { guardReplicaWrite } from '@/lib/nebula/primary'
import { withApiError } from '@/lib/api/with-error'
import * as piholeClient from '@/lib/pihole/client'

export const GET = withApiError(
  async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const session = await auth()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const { id } = await params
    // R2-NV2: a disabled node gets no calls, not even reads.
    const guard = await enabledInstance(id)
    if (guard.denied) return guard.denied
    return NextResponse.json({ clients: await piholeClient.getClients(id) })
  }
)

export const POST = withApiError(
  async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const denied = await requireAdmin()
    if (denied) return denied
    const { id } = await params
    const replica = await guardReplicaWrite(id)
    if (replica) return replica
    const { client, comment, groups } = await req.json()
    if (!client || typeof client !== 'string') {
      return NextResponse.json({ error: 'client is required' }, { status: 400 })
    }
    const g = groups ?? [0]
    if (!isGroupIds(g)) return NextResponse.json({ error: 'groups must be a non-empty array of group ids' }, { status: 400 })
    await auditedNodeCall('client.add', id, client, () => piholeClient.addClient(id, client, comment ?? '', g))
    return NextResponse.json({ ok: true }, { status: 201 })
  }
)

export const PUT = withApiError(
  async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const denied = await requireAdmin()
    if (denied) return denied
    const { id } = await params
    const replica = await guardReplicaWrite(id)
    if (replica) return replica
    const { client, comment, groups } = await req.json()
    if (!client || typeof client !== 'string') {
      return NextResponse.json({ error: 'client is required' }, { status: 400 })
    }
    if (groups !== undefined && !isGroupIds(groups)) {
      return NextResponse.json({ error: 'groups must be a non-empty array of group ids' }, { status: 400 })
    }
    await auditedNodeCall('client.update', id, client, () => piholeClient.updateClient(id, client, { comment, groups }))
    return NextResponse.json({ ok: true })
  }
)

export const DELETE = withApiError(
  async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const denied = await requireAdmin()
    if (denied) return denied
    const { id } = await params
    const replica = await guardReplicaWrite(id)
    if (replica) return replica
    const { client } = await req.json()
    if (!client || typeof client !== 'string') {
      return NextResponse.json({ error: 'client is required' }, { status: 400 })
    }
    await auditedNodeCall('client.remove', id, client, () => piholeClient.removeClient(id, client))
    return NextResponse.json({ ok: true })
  }
)
