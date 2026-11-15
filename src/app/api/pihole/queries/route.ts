import { errMsg } from '@/lib/errors'
import { intParam } from '@/lib/pihole/validate'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { instances } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import * as piholeClient from '@/lib/pihole/client'
import type { PiHoleQuery } from '@/lib/pihole/types'
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

type TaggedQuery = PiHoleQuery & { instanceId: string; instanceName: string }

export async function GET(req: Request) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const url = new URL(req.url)
  const from = url.searchParams.get('from') ? parseInt(url.searchParams.get('from')!, 10) : undefined
  const until = url.searchParams.get('until') ? parseInt(url.searchParams.get('until')!, 10) : undefined
  const length = intParam(url.searchParams.get('length'), 100, 1, 1000)
  const domain = url.searchParams.get('domain') ?? undefined
  const client_ip = url.searchParams.get('client_ip') ?? undefined
  // Pi-hole matches these exactly unless they contain * wildcards.
  const client_name = url.searchParams.get('client_name') ?? undefined

  const activeInstances = await db.query.instances.findMany({
    where: eq(instances.enabled, true),
  })

  const results = await Promise.allSettled(
    activeInstances.map((inst) =>
      piholeClient.getQueries(inst.id, { from, until, length, domain, client_ip, client_name }, req.signal).then((r) =>
        r.queries.map((q): TaggedQuery => ({ ...q, instanceId: inst.id, instanceName: inst.name }))
      )
    )
  )

  const merged: TaggedQuery[] = []
  const failures: { name: string; error: string }[] = []
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') merged.push(...result.value)
    else failures.push({ name: activeInstances[i].name, error: errMsg(result.reason) })
  })

  merged.sort((a, b) => b.time - a.time)
  const trimmed = merged.slice(0, length)
  const oldestTimestamp = trimmed.length > 0 ? trimmed[trimmed.length - 1].time : null

  return NextResponse.json({ queries: trimmed, oldestTimestamp, ...(failures.length && { failures }) })
}
