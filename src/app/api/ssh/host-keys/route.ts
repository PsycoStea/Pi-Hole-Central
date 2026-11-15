import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth-guard'
import { withApiError } from '@/lib/api/with-error'
import { logAudit } from '@/lib/audit'
import { forgetPin, listPins } from '@/lib/ssh/host-keys'

export const dynamic = 'force-dynamic'

/** Pinned SSH host keys (one per host). */
export const GET = withApiError(async () => {
  const denied = await requireAdmin()
  if (denied) return denied
  return NextResponse.json({ pins: await listPins() })
})

/** Forget a host's pin (after a legitimate reinstall); the next connection re-pins. */
export const DELETE = withApiError(async (req: Request) => {
  const denied = await requireAdmin()
  if (denied) return denied
  const { host } = await req.json().catch(() => ({}))
  if (typeof host !== 'string' || !/^[A-Za-z0-9.:-]+$/.test(host)) {
    return NextResponse.json({ error: 'host is required' }, { status: 400 })
  }
  const existed = await forgetPin(host)
  if (!existed) return NextResponse.json({ error: `no pinned key for ${host}` }, { status: 404 })
  await logAudit('ssh.hostkey.forget', '', host)
  return NextResponse.json({ ok: true })
})
