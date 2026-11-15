import { enabledInstance } from '@/lib/pihole/instance-guard'
import { auth } from '@/lib/auth'
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
    const groups = await piholeClient.getGroups(id)
    return NextResponse.json({ groups })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 })
  }
}
