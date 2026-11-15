import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth-guard'
import { withApiError } from '@/lib/api/with-error'
import { db } from '@/lib/db'
import { backupHistory, instances } from '@/lib/db/schema'
import { desc, eq } from 'drizzle-orm'
import { logAudit } from '@/lib/audit'

export const dynamic = 'force-dynamic'

export const GET = withApiError(async () => {
  const denied = await requireAdmin()
  if (denied) return denied
  const rows = await db.query.backupHistory.findMany({
    orderBy: desc(backupHistory.createdAt),
    limit: 200,
  })
  const insts = await db.query.instances.findMany()
  const nameById = new Map(insts.map((i) => [i.id, i.name]))
  return NextResponse.json(
    rows.map((r) => ({ ...r, instanceName: nameById.get(r.instanceId) ?? r.instanceId }))
  )
})

// Trigger a manual backup for one instance ({instanceId}) or all enabled ({all:true}).
export const POST = withApiError(async (req: Request) => {
  const denied = await requireAdmin()
  if (denied) return denied
  const { runBackup } = await import('@/lib/backup/service')
  const body = await req.json().catch(() => ({}))

  let targets
  if (body.all === true) {
    targets = await db.query.instances.findMany({ where: eq(instances.enabled, true) })
  } else if (body.instanceId) {
    const inst = await db.query.instances.findFirst({ where: eq(instances.id, body.instanceId) })
    if (!inst) return NextResponse.json({ error: 'Instance not found' }, { status: 404 })
    targets = [inst]
  } else {
    return NextResponse.json({ error: 'Provide instanceId or all=true' }, { status: 400 })
  }

  const results = []
  for (const inst of targets) {
    const r = await runBackup(inst, 'manual')
    results.push({ instanceId: inst.id, name: inst.name, ...r })
  }
  await logAudit('backup.run', body.all ? 'all' : body.instanceId, `${results.filter((x) => x.ok).length}/${results.length} ok`)
  return NextResponse.json({ results })
})
