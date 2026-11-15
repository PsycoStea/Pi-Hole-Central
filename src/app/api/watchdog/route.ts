import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { requireAdmin } from '@/lib/auth-guard'
import { db } from '@/lib/db'
import { appSettings, alertSettings, recoveryEvents, instances } from '@/lib/db/schema'
import { eq, or, desc } from 'drizzle-orm'
import { logAudit } from '@/lib/audit'

export async function GET() {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const [enSetting, thSetting, alertRow, events, allInstances] = await Promise.all([
    db.query.appSettings.findFirst({ where: eq(appSettings.key, 'watchdog_enabled') }),
    db.query.appSettings.findFirst({ where: eq(appSettings.key, 'watchdog_threshold') }),
    db.query.alertSettings.findFirst({ where: eq(alertSettings.type, 'watchdog_restart') }),
    db.query.recoveryEvents.findMany({
      where: or(
        eq(recoveryEvents.eventType, 'watchdog_restart'),
        eq(recoveryEvents.eventType, 'watchdog_elevated'),
        eq(recoveryEvents.eventType, 'watchdog_ceiling')
      ),
      orderBy: desc(recoveryEvents.timestamp),
      limit: 100,
    }),
    db.query.instances.findMany(),
  ])

  const instanceMap = new Map(allInstances.map((i) => [i.id, i.name]))

  return NextResponse.json({
    enabled: (enSetting?.value ?? 'true') === 'true',
    threshold: parseInt(thSetting?.value ?? '30', 10),
    channelIds: alertRow ? JSON.parse(alertRow.channelIdsJson) : [],
    events: events.map((e) => ({
      ...e,
      instanceName: instanceMap.get(e.instanceId) ?? e.instanceId,
    })),
  })
}

export async function PUT(req: Request) {
  const denied = await requireAdmin()
  if (denied) return denied

  // Validate everything, then write in one transaction, then audit (R1-F3:
  // {enabled:false, threshold:0} used to turn the watchdog off and return 400).
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Request body must be a JSON object' }, { status: 400 })
  }
  const { enabled, threshold, channelIds } = body

  if (enabled !== undefined && typeof enabled !== 'boolean') {
    return NextResponse.json({ error: 'enabled must be a boolean' }, { status: 400 })
  }
  let t: number | undefined
  if (threshold !== undefined) {
    t = parseInt(threshold, 10)
    if (isNaN(t) || t < 1 || t > 200) {
      return NextResponse.json({ error: 'threshold must be between 1 and 200' }, { status: 400 })
    }
  }
  if (channelIds !== undefined) {
    if (!Array.isArray(channelIds) || channelIds.some((c) => typeof c !== 'string')) {
      return NextResponse.json({ error: 'channelIds must be an array of strings' }, { status: 400 })
    }
  }

  const existing = await db.query.alertSettings.findFirst({
    where: eq(alertSettings.type, 'watchdog_restart'),
  })
  const { randomUUID } = await import('crypto')

  // better-sqlite3 transactions are synchronous: no await inside.
  db.transaction((tx) => {
    const put = (key: string, value: string) =>
      tx.insert(appSettings).values({ key, value }).onConflictDoUpdate({ target: appSettings.key, set: { value } }).run()
    if (typeof enabled === 'boolean') put('watchdog_enabled', String(enabled))
    if (t !== undefined) put('watchdog_threshold', String(t))
    if (channelIds !== undefined) {
      const json = JSON.stringify(channelIds)
      // Picking channels here is a request to be notified. Push is gated on
      // pushEnabled, which this used to leave false, so nothing was ever sent.
      const pushEnabled = channelIds.length > 0
      if (existing) {
        tx.update(alertSettings).set({ channelIdsJson: json, pushEnabled }).where(eq(alertSettings.id, existing.id)).run()
      } else {
        tx.insert(alertSettings).values({
          id: randomUUID(),
          type: 'watchdog_restart',
          enabled: true,
          channelIdsJson: json,
          pushEnabled,
        }).run()
      }
    }
  })

  await logAudit(
    'watchdog.update',
    '',
    [
      typeof enabled === 'boolean' ? `enabled=${enabled}` : '',
      t !== undefined ? `threshold=${t}` : '',
      channelIds !== undefined ? `channels=${channelIds.length}` : '',
    ].filter(Boolean).join(', ')
  )
  return NextResponse.json({ ok: true })
}
