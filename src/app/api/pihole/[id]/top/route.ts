import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import * as piholeClient from '@/lib/pihole/client'
import { enabledInstance, nodeErrorResponse } from '@/lib/pihole/instance-guard'

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params
  const guard = await enabledInstance(id)
  if (guard.denied) return guard.denied
  try {
    const [topDomains, topClients] = await Promise.all([
      piholeClient.getTopDomains(id, 10, req.signal),
      piholeClient.getTopClients(id, 10, req.signal),
    ])
    return NextResponse.json({ topDomains, topClients })
  } catch (err) {
    return nodeErrorResponse(err)
  }
}
