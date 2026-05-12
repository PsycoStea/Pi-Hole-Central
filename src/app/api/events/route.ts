import { auth } from '@/lib/auth'
import { getLatestData, subscribe } from '@/lib/polling/live-cache'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const session = await auth()
  if (!session) return new Response('Unauthorized', { status: 401 })

  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    start(controller) {
      let closed = false
      const send = (data: unknown) => {
        if (!closed) controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
      }

      // Send current cached data immediately so the dashboard isn't blank on load
      const current = getLatestData()
      if (current) send(current)

      const unsubscribe = subscribe((data) => send(data))

      req.signal.addEventListener('abort', () => {
        closed = true
        unsubscribe()
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
