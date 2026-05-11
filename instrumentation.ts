export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startPolling } = await import('./src/lib/polling/worker')
    startPolling()
  }
}
