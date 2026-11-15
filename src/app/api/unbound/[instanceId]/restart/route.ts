import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth-guard'
import { withApiError } from '@/lib/api/with-error'
import { logAudit } from '@/lib/audit'
import { errMsg } from '@/lib/errors'
import { db } from '@/lib/db'
import { instances, recoveryEvents } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { connectSSH, extractHost } from '@/lib/ssh/client'
import { restartUnbound } from '@/lib/ssh/unbound'

export const POST = withApiError(
  async (_req: Request, { params }: { params: Promise<{ instanceId: string }> }) => {
    const denied = await requireAdmin()
    if (denied) return denied

    const { instanceId } = await params
    const instance = await db.query.instances.findFirst({ where: eq(instances.id, instanceId) })
    if (!instance?.sshUsername) {
      return NextResponse.json({ error: 'Instance not found or SSH not configured' }, { status: 404 })
    }

    let outcome = 'failed'
    let ssh = null
    try {
      ssh = await connectSSH({
        host: extractHost(instance.url),
        username: instance.sshUsername,
        passwordEncrypted: instance.sshPasswordEncrypted,
      })
      const { code, error } = await restartUnbound(ssh)
      const success = code === 0
      outcome = success ? 'ok' : `failed (exit ${code})`
      await db.insert(recoveryEvents).values({
        instanceId,
        timestamp: new Date(),
        eventType: 'unbound_restart',
        detail: success ? 'Unbound restarted via dashboard' : `Restart failed (exit code ${code}): ${error ?? ''}`,
        success,
      })
      return NextResponse.json({ success, ...(error && { error }) })
    } catch (err) {
      outcome = `failed: ${errMsg(err)}`
      throw err
    } finally {
      if (ssh) ssh.dispose()
      await logAudit('unbound.restart', instanceId, outcome)
    }
  }
)
