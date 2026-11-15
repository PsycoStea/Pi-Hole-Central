import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { withApiError } from '@/lib/api/with-error'
import { getSyncStatus } from '@/lib/nebula/drift'
import { getNebulaHostStatus, redactForViewer } from '@/lib/nebula/host'

export const dynamic = 'force-dynamic'

// Any session may read the (cached) sync status. Only admins may force a
// refresh: it opens a root SSH session to the nebula host and makes six Pi-hole
// GETs per node, and its only UI caller is the admin-only Settings -> Sync page.
// A viewer's refresh=1 is refused (403) rather than quietly served the cache, so
// the policy is explicit and a viewer can never trigger a computation through
// it. Even for admins, refreshes are coalesced and rate-limited in lib/nebula
// (audit R2-NV1). Raw container logs are admin-only (audit R3A-NV2).
export const GET = withApiError(async (req: Request) => {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const isAdmin = session.user.role === 'admin'
  const force = new URL(req.url).searchParams.get('refresh') === '1'
  if (force && !isAdmin) {
    return NextResponse.json({ error: 'Forbidden: only admins can force a refresh' }, { status: 403 })
  }
  const [drift, host] = await Promise.all([getSyncStatus(force), getNebulaHostStatus(force)])
  return NextResponse.json({ ...drift, host: isAdmin ? host : redactForViewer(host) })
})
