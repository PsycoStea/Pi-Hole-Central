export async function register() {
  if (process.env.NEXT_RUNTIME === 'edge') return
  // `next build` loads this file too. Starting the poller there runs against a
  // database that does not exist yet, so skip it during the build phase.
  if (process.env.NEXT_PHASE === 'phase-production-build') return

  const { startPolling } = await import('@/lib/polling/worker')
  startPolling()
}
