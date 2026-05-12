import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { instances } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import * as piholeClient from '@/lib/pihole/client'
import type { Domain } from '@/lib/pihole/types'
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

type TaggedDomain = Domain & { instanceId: string; instanceName: string }

export async function GET(req: Request) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const list = (new URL(req.url).searchParams.get('list') ?? 'allow') as 'allow' | 'deny'

  const activeInstances = await db.query.instances.findMany({
    where: eq(instances.enabled, true),
  })

  const results = await Promise.allSettled(
    activeInstances.map((inst) =>
      piholeClient.getDomains(inst.id, list).then((domains) =>
        domains.map((d): TaggedDomain => ({ ...d, instanceId: inst.id, instanceName: inst.name }))
      )
    )
  )

  const merged: TaggedDomain[] = []
  for (const result of results) {
    if (result.status === 'fulfilled') merged.push(...result.value)
  }

  merged.sort((a, b) => a.domain.localeCompare(b.domain))

  return NextResponse.json({ domains: merged })
}
