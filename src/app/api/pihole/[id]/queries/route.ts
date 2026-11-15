import { intParam } from '@/lib/pihole/validate'
import { auth } from '@/lib/auth'
import * as piholeClient from '@/lib/pihole/client'
import { enabledInstance, nodeErrorResponse } from '@/lib/pihole/instance-guard'
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const guard = await enabledInstance(id)
  if (guard.denied) return guard.denied
  const url = new URL(req.url)
  const from = url.searchParams.get('from') ? parseInt(url.searchParams.get('from')!, 10) : undefined
  const until = url.searchParams.get('until') ? parseInt(url.searchParams.get('until')!, 10) : undefined
  const length = intParam(url.searchParams.get('length'), 50, 1, 1000)
  const cursor = url.searchParams.get('cursor') ?? undefined
  const domain = url.searchParams.get('domain') ?? undefined
  const client_ip = url.searchParams.get('client_ip') ?? undefined
  // Pi-hole matches these exactly unless they contain * wildcards.
  const client_name = url.searchParams.get('client_name') ?? undefined

  // from/until are clamped to the last 30 days and the cursor offset to >= 0
  // inside getQueries; the node call runs in the node's heavy lane.
  try {
    const result = await piholeClient.getQueries(id, { from, until, length, cursor, domain, client_ip, client_name }, req.signal)
    return NextResponse.json(result)
  } catch (err) {
    return nodeErrorResponse(err)
  }
}
