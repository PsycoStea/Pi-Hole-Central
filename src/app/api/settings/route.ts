import { auth } from '@/lib/auth'
import { requireAdmin } from '@/lib/auth-guard'
import { db } from '@/lib/db'
import { appSettings, instances } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { logAudit } from '@/lib/audit'
import { getPrimaryNode, PRIMARY_SETTING_KEY } from '@/lib/nebula/primary'
import { AUDIT_RETENTION_DEFAULT, AUDIT_RETENTION_MIN } from '@/lib/audit'

export async function GET() {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const [auditRet, retSetting, pollSetting, statsSetting, updateCheckSetting, bInterval, bRetention, bWebhook, bToken, nHost, nUser, nContainer, primary] =
    await Promise.all([
      db.query.appSettings.findFirst({ where: eq(appSettings.key, 'audit_retention_days') }),
      db.query.appSettings.findFirst({ where: eq(appSettings.key, 'retention_days') }),
      db.query.appSettings.findFirst({ where: eq(appSettings.key, 'poll_interval_seconds') }),
      db.query.appSettings.findFirst({ where: eq(appSettings.key, 'stats_interval_seconds') }),
      db.query.appSettings.findFirst({ where: eq(appSettings.key, 'update_check_interval') }),
      db.query.appSettings.findFirst({ where: eq(appSettings.key, 'backup_interval') }),
      db.query.appSettings.findFirst({ where: eq(appSettings.key, 'backup_retention_count') }),
      db.query.appSettings.findFirst({ where: eq(appSettings.key, 'backup_webhook_url') }),
      db.query.appSettings.findFirst({ where: eq(appSettings.key, 'backup_webhook_token') }),
      db.query.appSettings.findFirst({ where: eq(appSettings.key, 'nebula_host') }),
      db.query.appSettings.findFirst({ where: eq(appSettings.key, 'nebula_ssh_user') }),
      db.query.appSettings.findFirst({ where: eq(appSettings.key, 'nebula_container') }),
      getPrimaryNode(),
    ])

  return NextResponse.json({
    retentionDays: parseInt(retSetting?.value ?? '30', 10),
    auditRetentionDays: parseInt(auditRet?.value ?? String(AUDIT_RETENTION_DEFAULT), 10),
    pollIntervalSeconds: parseInt(pollSetting?.value ?? '300', 10),
    statsIntervalSeconds: parseInt(statsSetting?.value ?? '300', 10),
    updateCheckInterval: updateCheckSetting?.value ?? 'daily',
    backupInterval: bInterval?.value ?? 'off',
    backupRetentionCount: parseInt(bRetention?.value ?? '14', 10),
    backupWebhookUrl: bWebhook?.value ?? '',
    // Never echo the token back to the client; only report whether one is set.
    backupWebhookTokenSet: !!(bToken?.value ?? '').trim(),
    nebulaHost: nHost?.value ?? '',
    nebulaSshUser: nUser?.value ?? 'root',
    nebulaContainer: nContainer?.value ?? 'nebula-sync',
    // The node nebula-sync copies FROM. Config editors write here only; null = not chosen yet.
    primaryInstanceId: primary?.id ?? null,
    primaryInstanceName: primary?.name ?? null,
  })
}

export async function PUT(req: Request) {
  const denied = await requireAdmin()
  if (denied) return denied

  // Validate the WHOLE body first, then write every field in one transaction,
  // then audit. Each field used to be saved just before the next one was
  // checked, so a bad later field returned 400 with earlier fields already
  // saved and no audit row (R1-F3).
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Request body must be a JSON object' }, { status: 400 })
  }
  const bad = (error: string) => NextResponse.json({ error }, { status: 400 })
  const writes: [key: string, value: string][] = []

  if (body.retentionDays !== undefined) {
    const days = parseInt(body.retentionDays, 10)
    if (isNaN(days) || days < 1 || days > 30) return bad('retentionDays must be between 1 and 30')
    writes.push(['retention_days', String(days)])
  }

  if (body.auditRetentionDays !== undefined) {
    const days = parseInt(body.auditRetentionDays, 10)
    if (isNaN(days) || days < AUDIT_RETENTION_MIN || days > 365) {
      return bad(`auditRetentionDays must be between ${AUDIT_RETENTION_MIN} and 365`)
    }
    writes.push(['audit_retention_days', String(days)])
  }

  if (body.pollIntervalSeconds !== undefined) {
    const secs = parseInt(body.pollIntervalSeconds, 10)
    if (isNaN(secs) || secs < 60 || secs > 3600) return bad('pollIntervalSeconds must be between 60 and 3600')
    writes.push(['poll_interval_seconds', String(secs)])
  }

  if (body.statsIntervalSeconds !== undefined) {
    const secs = parseInt(body.statsIntervalSeconds, 10)
    if (isNaN(secs) || secs < 60 || secs > 3600) return bad('statsIntervalSeconds must be between 60 and 3600')
    writes.push(['stats_interval_seconds', String(secs)])
  }

  if (body.updateCheckInterval !== undefined) {
    if (!['daily', 'weekly', 'monthly'].includes(body.updateCheckInterval)) {
      return bad('updateCheckInterval must be daily, weekly, or monthly')
    }
    writes.push(['update_check_interval', body.updateCheckInterval])
  }

  if (body.backupInterval !== undefined) {
    if (!['off', 'daily', 'weekly'].includes(body.backupInterval)) {
      return bad('backupInterval must be off, daily, or weekly')
    }
    writes.push(['backup_interval', body.backupInterval])
  }

  if (body.backupRetentionCount !== undefined) {
    const n = parseInt(body.backupRetentionCount, 10)
    if (isNaN(n) || n < 1 || n > 100) return bad('backupRetentionCount must be between 1 and 100')
    writes.push(['backup_retention_count', String(n)])
  }

  if (body.backupWebhookUrl !== undefined) {
    const url = String(body.backupWebhookUrl).trim()
    if (url && !/^https?:\/\//.test(url)) return bad('backupWebhookUrl must be an http(s) URL')
    writes.push(['backup_webhook_url', url])
  }

  // Only overwrite the token when a non-empty value is provided (empty = leave as-is);
  // send backupWebhookTokenClear: true to remove it.
  if (typeof body.backupWebhookToken === 'string' && body.backupWebhookToken.trim()) {
    writes.push(['backup_webhook_token', body.backupWebhookToken.trim()])
  }
  if (body.backupWebhookTokenClear === true) {
    writes.push(['backup_webhook_token', ''])
  }

  if (body.nebulaHost !== undefined) {
    const h = String(body.nebulaHost).trim()
    // hostname or IP only — it's used as an SSH target
    if (h && !/^[A-Za-z0-9.-]+$/.test(h)) return bad('nebulaHost must be a hostname or IP')
    writes.push(['nebula_host', h])
  }
  if (body.nebulaSshUser !== undefined) {
    const u = String(body.nebulaSshUser).trim()
    if (u && !/^[A-Za-z0-9_-]+$/.test(u)) return bad('nebulaSshUser invalid')
    writes.push(['nebula_ssh_user', u || 'root'])
  }
  if (body.nebulaContainer !== undefined) {
    const c = String(body.nebulaContainer).trim()
    if (c && !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(c)) return bad('nebulaContainer invalid')
    writes.push(['nebula_container', c || 'nebula-sync'])
  }

  if (body.primaryInstanceId !== undefined) {
    // '' or null clears it (editors fall back to writing anywhere, with a banner).
    const id = body.primaryInstanceId === null ? '' : String(body.primaryInstanceId).trim()
    if (id && !(await db.query.instances.findFirst({ where: eq(instances.id, id) }))) {
      return bad('primaryInstanceId must be an existing instance')
    }
    writes.push([PRIMARY_SETTING_KEY, id])
  }

  // Old values, for an audit row that says what actually changed.
  const before = new Map(
    (await db.select().from(appSettings)).map((r) => [r.key, r.value] as const)
  )

  // The token belongs to the URL it was entered for. A new URL with no new
  // token in the same request clears it, so it is never sent to a host it was
  // not meant for (R3A-F1). The settings page re-sends the unchanged URL on
  // every save, so only an actual change counts.
  const newUrl = writes.find(([k]) => k === 'backup_webhook_url')?.[1]
  const tokenInRequest = writes.some(([k]) => k === 'backup_webhook_token')
  if (newUrl !== undefined && newUrl !== (before.get('backup_webhook_url') ?? '') && !tokenInRequest) {
    writes.push(['backup_webhook_token', ''])
  }

  // better-sqlite3 transactions are synchronous: no await inside.
  db.transaction((tx) => {
    for (const [key, value] of writes) {
      tx.insert(appSettings).values({ key, value }).onConflictDoUpdate({ target: appSettings.key, set: { value } }).run()
    }
  })

  const changes = writes
    .filter(([key, value]) => (before.get(key) ?? '') !== value)
    .map(([key, value]) =>
      key === 'backup_webhook_token'
        ? (value ? 'backup_webhook_token set' : 'backup_webhook_token cleared')
        : `${key}: ${JSON.stringify(before.get(key) ?? '')} -> ${JSON.stringify(value)}`
    )
  await logAudit('settings.update', '', changes.join('; ') || 'no change')
  return NextResponse.json({ ok: true })
}
