import { isBuildPhase, runOnce } from '@/lib/global-state'

export function startUnboundPollingOnce() {
  if (isBuildPhase()) return
  runOnce('__piholeCentralUnboundPollingStarted', () => {
    import('./status-cache')
      .then(({ startUnboundPolling }) => startUnboundPolling())
      .catch((err) => console.error('[unbound-init] Failed to start polling:', err))
  })
}
