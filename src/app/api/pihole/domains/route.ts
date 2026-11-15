import { isList } from '@/lib/pihole/validate'
import { errMsg } from '@/lib/errors'
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

  const list = new URL(req.url).searchParams.get('list') ?? 'allow'
  if (!isList(list)) return NextResponse.json({ error: 'list must be allow|deny' }, { status: 400 })

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

  // Report nodes that didn't answer, as /api/pihole/lists does. Dropping them
  // silently made a half-empty list look complete.
  const merged: TaggedDomain[] = []
  const failures: { name: string; error: string }[] = []
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') merged.push(...result.value)
    else failures.push({ name: activeInstances[i].name, error: errMsg(result.reason) })
  })

  merged.sort((a, b) => a.domain.localeCompare(b.domain))

  return NextResponse.json({ domains: merged, ...(failures.length && { failures }) })
}
