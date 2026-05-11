import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { sendTest } from '@/lib/notifications'

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
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
