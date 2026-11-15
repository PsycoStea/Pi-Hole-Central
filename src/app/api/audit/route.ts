import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth-guard'
import { withApiError } from '@/lib/api/with-error'
import { db } from '@/lib/db'
import { auditLog } from '@/lib/db/schema'
import { and, desc, eq, count, like, type SQL } from 'drizzle-orm'

export const dynamic = 'force-dynamic'

export const GET = withApiError(async (req: Request) => {
  const denied = await requireAdmin()
  if (denied) return denied

  const params = new URL(req.url).searchParams
  const conds: SQL[] = []
  const action = params.get('action')
  const user = params.get('user')
  if (action) conds.push(eq(auditLog.action, action))
  if (user) conds.push(like(auditLog.username, `%${user}%`))
  const where = conds.length ? and(...conds) : undefined

  const limit = Math.min(200, Math.max(1, parseInt(params.get('limit') ?? '50', 10) || 50))
  const offset = Math.max(0, parseInt(params.get('offset') ?? '0', 10) || 0)

  const [rows, [totalRow], actions] = await Promise.all([
    db.query.auditLog.findMany({ where, orderBy: desc(auditLog.timestamp), limit, offset }),
    db.select({ c: count() }).from(auditLog).where(where),
    // distinct action list for the filter dropdown
    db.selectDistinct({ action: auditLog.action }).from(auditLog),
  ])

  return NextResponse.json({
    entries: rows,
    total: totalRow?.c ?? 0,
    actions: actions.map((a) => a.action).sort(),
  })
})
