import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { requireAdmin } from '@/lib/auth-guard'
import * as piholeClient from '@/lib/pihole/client'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params
  const status = await piholeClient.getBlockingStatus(id)
  return NextResponse.json(status)
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireAdmin()
  if (denied) return denied
  const { id } = await params
  const body = await req.json()
  const result = await piholeClient.setBlocking(id, body.enabled, body.timer)
  return NextResponse.json(result)
}
