import { enabledInstance } from '@/lib/pihole/instance-guard'
import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { requireAdmin } from '@/lib/auth-guard'
import { withApiError } from '@/lib/api/with-error'
import { auditedNodeCall } from '@/lib/audit'
import * as piholeClient from '@/lib/pihole/client'

export const GET = withApiError(
  async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const session = await auth()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const { id } = await params
    // R2-NV2: a disabled node gets no calls, not even reads.
    const guard = await enabledInstance(id)
    if (guard.denied) return guard.denied
    const status = await piholeClient.getBlockingStatus(id)
    return NextResponse.json(status)
  }
)

export const POST = withApiError(
  async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const denied = await requireAdmin()
    if (denied) return denied
    const { id } = await params
    const body = await req.json()
    if (typeof body.enabled !== 'boolean') {
      return NextResponse.json({ error: 'enabled must be a boolean' }, { status: 400 })
    }
    const timer = body.timer ?? null
    if (timer !== null && !(Number.isInteger(timer) && timer > 0 && timer <= 86_400)) {
      return NextResponse.json({ error: 'timer must be null or 1-86400 seconds' }, { status: 400 })
    }
    const result = await auditedNodeCall(
      'blocking.toggle',
      id,
      `${body.enabled ? 'enabled' : 'disabled'}${timer ? ` for ${timer}s` : ''}`,
      () => piholeClient.setBlocking(id, body.enabled, timer ?? undefined)
    )
    return NextResponse.json(result)
  }
)
