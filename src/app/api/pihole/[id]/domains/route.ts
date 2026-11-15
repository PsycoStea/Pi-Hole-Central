import { enabledInstance } from '@/lib/pihole/instance-guard'
import { isDomainEntry, isGroupIds, isKind, isList } from '@/lib/pihole/validate'
import { auth } from '@/lib/auth'
import { requireAdmin } from '@/lib/auth-guard'
import { guardReplicaWrite } from '@/lib/nebula/primary'
import * as piholeClient from '@/lib/pihole/client'
import { auditedNodeCall } from '@/lib/audit'
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  // R2-NV2: a disabled node gets no calls, not even reads.
  const guard = await enabledInstance(id)
  if (guard.denied) return guard.denied
  const list = new URL(req.url).searchParams.get('list') ?? 'allow'
  if (!isList(list)) return NextResponse.json({ error: 'list must be allow|deny' }, { status: 400 })
  try {
    const domains = await piholeClient.getDomains(id, list)
    return NextResponse.json({ domains })
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
  const { domain, list, kind = 'exact', comment = '', groups = [0], enabled = true } = await req.json()
  if (!isDomainEntry(domain)) return NextResponse.json({ error: 'domain is required (no spaces)' }, { status: 400 })
  if (!isList(list)) return NextResponse.json({ error: 'list must be allow|deny' }, { status: 400 })
  if (!isKind(kind)) return NextResponse.json({ error: 'kind must be exact|regex' }, { status: 400 })
  if (!isGroupIds(groups)) return NextResponse.json({ error: 'groups must be a non-empty array of group ids' }, { status: 400 })
  if (typeof enabled !== 'boolean') return NextResponse.json({ error: 'enabled must be a boolean' }, { status: 400 })

  try {
    await auditedNodeCall('domain.add', id, `${list}/${kind}: ${domain}`, () => piholeClient.addDomain(id, domain, list, kind, comment, groups, enabled))
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 })
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = await requireAdmin()
  if (denied) return denied

  const { id } = await params
  const replica = await guardReplicaWrite(id)
  if (replica) return replica
  const { list, kind, domain: domainStr } = await req.json()
  if (!isDomainEntry(domainStr) || !isList(list) || !isKind(kind)) {
    return NextResponse.json({ error: 'domain, list (allow|deny) and kind (exact|regex) are required' }, { status: 400 })
  }

  try {
    await auditedNodeCall('domain.remove', id, `${list}/${kind}: ${domainStr}`, () => piholeClient.removeDomain(id, list, kind, domainStr))
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 })
  }
}
