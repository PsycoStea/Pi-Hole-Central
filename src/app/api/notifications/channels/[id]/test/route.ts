import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth-guard'
import { sendTest } from '@/lib/notifications'

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireAdmin()
  if (denied) return denied
  const { id } = await params
  try {
    await sendTest(id)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Test failed' },
      { status: 400 }
    )
  }
}
