import { EventEmitter } from 'node:events'
import { globalSingleton, runOnce } from '@/lib/global-state'

/**
 * Process shutdown, in an order that lets both jobs finish:
 *
 *  1. Log out cached Pi-hole sessions (capped at 3s), so they don't hold API
 *     seats on the nodes after a restart.
 *  2. Close the live-update (SSE) streams.
 *
 * Next's own SIGTERM handler calls server.close() and exits once every open
 * connection has ended. An open dashboard's SSE stream never ends by itself,
 * so before this the process sat out Docker's 10s grace period and was
 * SIGKILLed on every deploy. Closing the streams lets Next exit normally, and
 * doing it after the logout means a dashboard being open still gives the
 * logout time to complete.
 */
export const shutdownEvents = globalSingleton('__piholeCentralShutdownEvents', () => {
  const e = new EventEmitter()
  e.setMaxListeners(0) // one listener per open dashboard tab
  return e
})

export const CLOSE_STREAMS = 'close-streams'

export function registerShutdownHandlers(): void {
  runOnce('__piholeCentralShutdownHandlers', () => {
    const onSignal = () => {
      runOnce('__piholeCentralShutdownStarted', () => {
        void shutdown()
      })
    }
    process.once('SIGTERM', onSignal)
    process.once('SIGINT', onSignal)
  })
}

async function shutdown(): Promise<void> {
  try {
    const { logoutAllSessions } = await import('@/lib/pihole/client')
    await Promise.race([logoutAllSessions(), new Promise((r) => setTimeout(r, 3000))])
  } catch {
    // Shutting down regardless.
  }
  shutdownEvents.emit(CLOSE_STREAMS)
}
