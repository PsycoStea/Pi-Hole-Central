import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import * as piholeClient from '@/lib/pihole/client'

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params
  await piholeClient.triggerGravity(id)
  return NextResponse.json({ ok: true, message: 'Gravity update triggered' })
}
