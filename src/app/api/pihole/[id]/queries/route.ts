import { auth } from '@/lib/auth'
import * as piholeClient from '@/lib/pihole/client'
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const url = new URL(req.url)
  const from = url.searchParams.get('from') ? parseInt(url.searchParams.get('from')!, 10) : undefined
  const until = url.searchParams.get('until') ? parseInt(url.searchParams.get('until')!, 10) : undefined
  const length = url.searchParams.get('length') ? parseInt(url.searchParams.get('length')!, 10) : 50
  const cursor = url.searchParams.get('cursor') ?? undefined
  const domain = url.searchParams.get('domain') ?? undefined
  const client_ip = url.searchParams.get('client_ip') ?? undefined

  try {
    const result = await piholeClient.getQueries(id, { from, until, length, cursor, domain, client_ip })
    return NextResponse.json(result)
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 })
  }
}
