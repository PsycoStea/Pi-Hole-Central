import { auth } from '@/lib/auth'
import { enabledInstance, nodeErrorResponse } from '@/lib/pihole/instance-guard'
import { getInstanceHistory } from '@/lib/pihole/history'
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
  // Only the three ranges the UI offers; anything else (NaN, huge) sent from=NaN.
  const requested = parseInt(url.searchParams.get('hours') ?? '24', 10)
  const hours = requested === 168 || requested === 720 ? requested : 24

  try {
    // 24h: live endpoint, raw 10-min buckets. 7d/30d: database endpoint in
    // 1 h / 6 h buckets, cached and shared (see lib/pihole/history.ts).
    const data = await getInstanceHistory(guard.instance, hours, req.signal)
    return NextResponse.json({ data })
  } catch (err) {
    return nodeErrorResponse(err)
  }
}
