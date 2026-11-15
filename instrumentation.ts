import { isBuildPhase } from './src/lib/global-state'

export async function register() {
  if (isBuildPhase()) return
  if (process.env.NEXT_RUNTIME !== 'edge') {
    const { startPolling } = await import('./src/lib/polling/worker')
    const { startUnboundPolling } = await import('./src/lib/unbound/status-cache')
    const { registerShutdownHandlers } = await import('./src/lib/shutdown')
    registerShutdownHandlers()
    startPolling()
    startUnboundPolling()
  }
}
