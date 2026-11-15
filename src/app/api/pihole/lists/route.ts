import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { instances } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import * as piholeClient from '@/lib/pihole/client'
import type { AdList } from '@/lib/pihole/types'
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

type TaggedList = AdList & { instanceId: string; instanceName: string }

export async function GET() {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const activeInstances = await db.query.instances.findMany({
    where: eq(instances.enabled, true),
  })

  const results = await Promise.allSettled(
    activeInstances.map((inst) =>
      piholeClient.getLists(inst.id).then((lists) =>
        lists.map((l): TaggedList => ({ ...l, instanceId: inst.id, instanceName: inst.name }))
      )
    )
  )

  const merged: TaggedList[] = []
  const failures: { name: string; error: string }[] = []

  for (let i = 0; i < results.length; i++) {
    const result = results[i]
    if (result.status === 'fulfilled') {
      merged.push(...result.value)
    } else {
      console.error(`[lists] Failed to fetch from ${activeInstances[i].name}:`, result.reason)
      failures.push({ name: activeInstances[i].name, error: String(result.reason) })
    }
  }

  merged.sort((a, b) => a.address.localeCompare(b.address))

  return NextResponse.json({ lists: merged, ...(failures.length && { failures }) })
}
