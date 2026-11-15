import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth-guard'
import { withApiError } from '@/lib/api/with-error'
import { logAudit } from '@/lib/audit'
import { errMsg } from '@/lib/errors'
import { db } from '@/lib/db'
import { instances } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { connectSSH, extractHost } from '@/lib/ssh/client'
import { flushUnboundCache } from '@/lib/ssh/unbound'

export const POST = withApiError(
  async (_req: Request, { params }: { params: Promise<{ instanceId: string }> }) => {
    const denied = await requireAdmin()
    if (denied) return denied

    const { instanceId } = await params
    const instance = await db.query.instances.findFirst({ where: eq(instances.id, instanceId) })
    if (!instance?.sshUsername) {
      return NextResponse.json({ error: 'Instance not found or SSH not configured' }, { status: 404 })
    }

    // Audited whether it works or not: the SSH action may have run on the node either way.
    let outcome = 'failed'
    let ssh = null
    try {
      ssh = await connectSSH({
        host: extractHost(instance.url),
        username: instance.sshUsername,
        passwordEncrypted: instance.sshPasswordEncrypted,
      })
      await flushUnboundCache(ssh)
      outcome = 'ok'
      return NextResponse.json({ ok: true })
    } catch (err) {
      outcome = `failed: ${errMsg(err)}`
      throw err
    } finally {
      if (ssh) ssh.dispose()
      await logAudit('unbound.flush', instanceId, outcome)
    }
  }
)
