import { auth } from '@/lib/auth'
import { requireAdmin } from '@/lib/auth-guard'
import { db } from '@/lib/db'
import { appSettings } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'

export async function GET() {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const setting = await db.query.appSettings.findFirst({
    where: eq(appSettings.key, 'retention_days'),
  })

  return NextResponse.json({ retentionDays: parseInt(setting?.value ?? '30', 10) })
}

export async function PUT(req: Request) {
  const denied = await requireAdmin()
  if (denied) return denied

  const { retentionDays } = await req.json()
  const days = parseInt(retentionDays, 10)
  if (isNaN(days) || days < 1 || days > 30) {
    return NextResponse.json({ error: 'retentionDays must be between 1 and 30' }, { status: 400 })
  }

  await db
    .insert(appSettings)
    .values({ key: 'retention_days', value: String(days) })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: String(days) } })

  return NextResponse.json({ retentionDays: days })
}
