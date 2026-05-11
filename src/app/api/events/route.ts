import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { instances } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import * as piholeClient from '@/lib/pihole/client'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const session = await auth()
  if (!session) return new Response('Unauthorized', { status: 401 })

  const encoder = new TextEncoder()
  let closed = false

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: unknown) => {
        if (!closed) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
        }
      }

      const poll = async () => {
        if (closed) return
        try {
          const activeInstances = await db.query.instances.findMany({
            where: eq(instances.enabled, true),
          })
          const results = await Promise.allSettled(
            activeInstances.map(async (inst) => {
              const summary = await piholeClient.getSummary(inst.id)
              return { id: inst.id, name: inst.name, status: 'online', summary }
            })
          )
          const instanceData = results.map((r, i) =>
            r.status === 'fulfilled'
              ? r.value
              : { id: activeInstances[i].id, name: activeInstances[i].name, status: 'offline', summary: null }
          )
          const online = instanceData.filter((i) => i.status === 'online' && i.summary)
          send({
            instances: instanceData,
            aggregated: {
              totalQueries: online.reduce((s, i) => s + (i.summary?.queries.total ?? 0), 0),
              totalBlocked: online.reduce((s, i) => s + (i.summary?.queries.blocked ?? 0), 0),
              blockPct: online.length
                ? online.reduce((s, i) => s + (i.summary?.queries.percent_blocked ?? 0), 0) / online.length
                : 0,
              instancesOnline: online.length,
              instancesTotal: activeInstances.length,
            },
          })
        } catch (err) {
          console.error('[SSE] poll error:', err)
        }
      }

      await poll()
      const interval = setInterval(poll, 30_000)
      req.signal.addEventListener('abort', () => {
        closed = true
        clearInterval(interval)
        controller.close()
      })
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  })
}
