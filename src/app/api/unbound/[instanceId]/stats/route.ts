import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth-guard'
import { withApiError } from '@/lib/api/with-error'
import { db } from '@/lib/db'
import { instances } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { connectSSH, extractHost } from '@/lib/ssh/client'
import { getUnboundStats } from '@/lib/ssh/unbound'

// withApiError: an SSH failure (unreachable, or a refused host key) returns its
// message as JSON instead of an empty 500 the UI can't explain.
export const GET = withApiError(async function GET(
  _req: Request,
  { params }: { params: Promise<{ instanceId: string }> }
) {
  const denied = await requireAdmin()
  if (denied) return denied

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
    return NextResponse.json(await getUnboundStats(ssh))
  } finally {
    if (ssh) ssh.dispose()
  }
})
