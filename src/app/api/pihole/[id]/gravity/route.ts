import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth-guard'
import * as piholeClient from '@/lib/pihole/client'

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireAdmin()
  if (denied) return denied
  const { id } = await params
  await piholeClient.triggerGravity(id)
  return NextResponse.json({ ok: true, message: 'Gravity update triggered' })
}
