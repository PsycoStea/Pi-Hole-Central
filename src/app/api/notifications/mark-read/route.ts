import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth-guard'
import { withApiError } from '@/lib/api/with-error'
import { db } from '@/lib/db'
import { notifications } from '@/lib/db/schema'
import { eq, inArray } from 'drizzle-orm'

export const dynamic = 'force-dynamic'

export const POST = withApiError(async (req: Request) => {
  const denied = await requireAdmin()
  if (denied) return denied

  const body = await req.json().catch(() => ({}))
  const ids: number[] | undefined = Array.isArray(body.ids) ? body.ids : undefined
  const read: boolean = body.read !== false // default true (mark read)

  if (ids && ids.length) {
    await db.update(notifications).set({ read }).where(inArray(notifications.id, ids))
  } else if (body.all === true) {
    // Mark all currently-unread as read (or all as unread when read=false).
    await db.update(notifications).set({ read }).where(eq(notifications.read, !read))
  } else {
    return NextResponse.json({ error: 'Provide ids[] or all=true' }, { status: 400 })
  }
  return NextResponse.json({ ok: true })
})
