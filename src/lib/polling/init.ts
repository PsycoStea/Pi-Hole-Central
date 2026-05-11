let started = false

export function startPollingOnce() {
  if (started) return
  started = true
  import('./worker')
    .then(({ startPolling }) => startPolling())
    .catch((err) => console.error('[init] Failed to start polling:', err))
}
