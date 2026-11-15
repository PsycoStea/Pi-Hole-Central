import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { appSettings, instances } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import type { VersionStatus } from '@/lib/polling/version-check'

export async function GET() {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const [statusSetting, allInstances] = await Promise.all([
    db.query.appSettings.findFirst({ where: eq(appSettings.key, 'version_status') }),
    db.query.instances.findMany(),
  ])

  const status: VersionStatus = statusSetting ? JSON.parse(statusSetting.value) : {}
  const updates = allInstances
    .filter((i) => status[i.id]?.hasUpdate)
    .map((i) => ({
      id: i.id,
      name: i.name,
      localCore: status[i.id].localCore,
      remoteCore: status[i.id].remoteCore,
    }))

  const firstKey = Object.keys(status)[0]
  return NextResponse.json({
    updates,
    checkedAt: firstKey ? status[firstKey].checkedAt : null,
  })
}
