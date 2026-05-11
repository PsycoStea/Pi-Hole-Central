import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import * as piholeClient from '@/lib/pihole/client'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params
  try {
    const [topDomains, topClients] = await Promise.all([
      piholeClient.getTopDomains(id, 10),
      piholeClient.getTopClients(id, 10),
    ])
    return NextResponse.json({ topDomains, topClients })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 })
  }
}
