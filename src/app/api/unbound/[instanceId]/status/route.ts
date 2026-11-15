import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getUnboundStatus } from '@/lib/unbound/status-cache'

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ instanceId: string }> }
) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { instanceId } = await params
  return NextResponse.json(getUnboundStatus(instanceId))
}
