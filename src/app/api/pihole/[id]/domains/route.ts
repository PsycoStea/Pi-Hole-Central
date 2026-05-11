import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import * as piholeClient from '@/lib/pihole/client'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params
  const { domain, list, action } = await req.json()
  if (!domain || !list || !action) {
    return NextResponse.json({ error: 'domain, list, and action required' }, { status: 400 })
  }
  if (action === 'add') {
    await piholeClient.addDomain(id, domain, list)
  } else {
    await piholeClient.removeDomain(id, domain, list)
  }
  return NextResponse.json({ ok: true })
}
