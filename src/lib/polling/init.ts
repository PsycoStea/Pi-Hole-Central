import { isBuildPhase, runOnce } from '@/lib/global-state'
import { registerShutdownHandlers } from '@/lib/shutdown'

export function startPollingOnce() {
  if (isBuildPhase()) return
  runOnce('__piholeCentralPollingStarted', () => {
    import('./worker')
      .then(({ startPolling }) => startPolling())
      .catch((err) => console.error('[init] Failed to start polling:', err))
    registerShutdownHandlers()
  })
}
