import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth-guard'
import { testConnection } from '@/lib/pihole/client'
import { isAllowedInstanceUrl } from '@/lib/pihole/validate'

export async function POST(req: Request) {
  const denied = await requireAdmin()
  if (denied) return denied
  const { url, password } = await req.json()
  if (!url || !password) {
    return NextResponse.json({ error: 'url and password required' }, { status: 400 })
  }
  if (!isAllowedInstanceUrl(url)) {
    return NextResponse.json(
      { error: 'url must be an http(s) address on a private/loopback network' },
      { status: 400 }
    )
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
