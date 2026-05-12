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

  try {
    const info = await piholeClient.getInstanceInfo(id)
    return NextResponse.json(info)
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 })
  }
}
