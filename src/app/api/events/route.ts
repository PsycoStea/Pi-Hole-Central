import { auth } from '@/lib/auth'
import { getLatestData, subscribe } from '@/lib/polling/live-cache'
import { shutdownEvents, CLOSE_STREAMS } from '@/lib/shutdown'
import { checkSession, onSessionsEnded } from '@/lib/session-check'
import { globalSingleton } from '@/lib/global-state'

export const dynamic = 'force-dynamic'

// The session is checked at connect AND for as long as the stream is open
// (audit R1-F2): an ended session (deleted, demoted, password changed or reset,
// signed out) closes the stream at once via onSessionsEnded, and this timed
// re-check is the backstop for anything that skips that signal.
const RECHECK_MS = 30_000

// Bounds (audit R2-F4). Only the Overview page opens a stream, so a person with
// several tabs and a phone stays well under the per-user cap; above it the
// client gets 429 and retries on its own backoff (max 30 s).
const MAX_STREAMS_PER_USER = 6
const MAX_STREAMS_TOTAL = 64
// A reader that stops reading makes frames pile up in this stream's queue (Next
// honours socket backpressure, so the backlog lands here, unbounded). The
// default strategy has highWaterMark 1, so desiredSize = 1 - queued frames.
// A healthy reader is at 0 or 1 queued; one frame arrives every 30 s, so being
// this far behind means the reader has stalled for about two minutes.
const MAX_QUEUED_FRAMES = 4

const open = globalSingleton('__piholeCentralSseOpen', () => ({
  total: 0,
  byUser: new Map<string, number>(),
}))

export async function GET(req: Request) {
  const session = await auth()
  if (!session?.user?.id) return new Response('Unauthorized', { status: 401 })
  const userId = session.user.id
  const tv = session.user.tv

  const mine = open.byUser.get(userId) ?? 0
  if (mine >= MAX_STREAMS_PER_USER || open.total >= MAX_STREAMS_TOTAL) {
    return new Response('Too many live streams', {
      status: 429,
      headers: { 'Retry-After': '30' },
    })
  }
  open.byUser.set(userId, mine + 1)
  open.total++
  // Two halves so an ended session can hand the user's slot back at once (a
  // stolen cookie's stuck sockets must not lock the owner out until nginx times
  // them out) while the process slot stays taken until the socket really closes.
  let userReleased = false
  const releaseUser = () => {
    if (userReleased) return
    userReleased = true
    const n = (open.byUser.get(userId) ?? 1) - 1
    if (n <= 0) open.byUser.delete(userId)
    else open.byUser.set(userId, n)
  }
  let totalReleased = false
  const release = () => {
    releaseUser()
    if (totalReleased) return
    totalReleased = true
    open.total--
  }

  const encoder = new TextEncoder()

  // hard = true: error the stream, which discards its queued frames. Used for
  // stalled readers (close() would keep the backlog until it is read, which a
  // stalled reader never does) and ended sessions. For a healthy reader Next
  // then destroys the response at once. For a stalled one it cannot: its pipe
  // is parked in res.write() waiting for a 'drain' that never comes, and a
  // WritableStream abort waits for that in-flight write. The socket then holds
  // one frame (plus kernel buffers) until the peer goes away; behind NPM,
  // nginx's send_timeout does that. So the stream's slot is released only when
  // the socket really closes (req.signal abort) or the runtime cancels the
  // stream, never at drop time: otherwise a stalled client could keep opening
  // new streams and park one frame per socket without limit.
  // hard = false: graceful close, used on shutdown.
  let cleanup = (_hard: boolean) => {}

  const stream = new ReadableStream({
    start(controller) {
      let closed = false
      const send = (data: unknown) => {
        if (closed) return
        if (controller.desiredSize !== null && controller.desiredSize < 1 - MAX_QUEUED_FRAMES) {
          console.warn(`[events] dropped a stalled live stream (user ${userId}); its slot frees when the connection closes`)
          cleanup(true)
          return
        }
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
        } catch {
          cleanup(true)
        }
      }

      // Send current cached data immediately so the dashboard isn't blank on load
      const current = getLatestData()
      if (current) send(current)

      const unsubscribe = subscribe((data) => send(data))

      const endSession = () => { cleanup(true); releaseUser() }
      const stopRevocations = onSessionsEnded((id) => { if (id === userId) endSession() })
      const recheck = setInterval(async () => {
        const check = await checkSession(userId, tv)
        if (check.status === 'deleted' || check.status === 'revoked') endSession()
        // 'error': keep streaming (fail open, see session-check.ts)
      }, RECHECK_MS)

      const onShutdown = () => cleanup(false)

      // Runs once, whichever comes first: the request aborting, the stream
      // being cancelled by the runtime (client went away without an abort), a
      // stalled reader, an ended session, or shutdown.
      cleanup = (hard: boolean) => {
        if (closed) return
        closed = true
        unsubscribe()
        stopRevocations()
        clearInterval(recheck)
        shutdownEvents.off(CLOSE_STREAMS, onShutdown)
        try {
          if (hard) controller.error(new Error('stream ended'))
          else { controller.close(); release() }
        } catch { /* already closed */ }
      }
      req.signal.addEventListener('abort', () => { cleanup(true); release() })
      // The client may have left while auth() was reading the DB: the signal is
      // then already aborted, the listener above never fires, and Next returns
      // early on a destroyed response without cancelling this stream.
      if (req.signal.aborted) { cleanup(true); release() }
      // On shutdown, end the stream so Next's graceful close can finish
      // (the browser reconnects to the new container on its own).
      shutdownEvents.once(CLOSE_STREAMS, onShutdown)
    },
    cancel() {
      cleanup(true)
      release()
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Behind nginx (NPM) proxy_buffering is on by default and would hold
      // these small frames back until a buffer fills. This header turns it off
      // for this response only.
      'X-Accel-Buffering': 'no',
    },
  })
}
