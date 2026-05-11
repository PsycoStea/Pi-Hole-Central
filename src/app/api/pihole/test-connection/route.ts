import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { testConnection } from '@/lib/pihole/client'

export async function POST(req: Request) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { url, password } = await req.json()
  if (!url || !password) {
    return NextResponse.json({ error: 'url and password required' }, { status: 400 })
  }
  try {
    const summary = await testConnection(url, password)
    return NextResponse.json({
      ok: true,
      queries: summary.queries.total,
      blocked: summary.queries.blocked,
    })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Connection failed' },
      { status: 400 }
    )
  }
}
