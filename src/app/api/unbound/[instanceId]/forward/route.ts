import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth-guard'
import { withApiError } from '@/lib/api/with-error'
import { db } from '@/lib/db'
import { instances } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { connectSSH, extractHost } from '@/lib/ssh/client'
import { applyForwardZone } from '@/lib/ssh/unbound'
import { invalidForwardAddrs, UPSTREAM_APPLY_DISABLED, UPSTREAM_APPLY_ENABLED } from '@/lib/unbound/presets'

export const POST = withApiError(
  async (req: Request, { params }: { params: Promise<{ instanceId: string }> }) => {
    const denied = await requireAdmin()
    if (denied) return denied
    // See UPSTREAM_APPLY_DISABLED: unsafe on these nodes until rewritten.
    if (!UPSTREAM_APPLY_ENABLED) return NextResponse.json({ error: UPSTREAM_APPLY_DISABLED }, { status: 503 })

    const { addrs } = await req.json()
    if (!Array.isArray(addrs) || addrs.length === 0 || addrs.some((a) => typeof a !== 'string')) {
      return NextResponse.json({ error: 'addrs must be a non-empty string array' }, { status: 400 })
    }
    const invalid = invalidForwardAddrs(addrs)
    if (invalid.length > 0) {
      return NextResponse.json(
        { error: `Invalid forward address(es): ${invalid.join(', ')}. Expected IP[@port][#hostname].` },
        { status: 400 }
      )
    }

    const { instanceId } = await params
    const instance = await db.query.instances.findFirst({ where: eq(instances.id, instanceId) })
    if (!instance?.sshUsername) {
      return NextResponse.json({ error: 'Instance not found or SSH not configured' }, { status: 404 })
    }

    let ssh = null
    try {
      ssh = await connectSSH({
        host: extractHost(instance.url),
        username: instance.sshUsername,
        passwordEncrypted: instance.sshPasswordEncrypted,
      })
      await applyForwardZone(ssh, addrs)
      return NextResponse.json({ ok: true })
    } finally {
      if (ssh) ssh.dispose()
    }
  }
)
