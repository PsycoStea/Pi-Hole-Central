export async function register() {
  if (process.env.NEXT_RUNTIME !== 'edge') {
    const { startPolling } = await import('./src/lib/polling/worker')
    startPolling()
  }
}
