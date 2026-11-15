export interface GotifyConfig {
  url: string
  token: string
  priority?: number
}

export async function send(title: string, message: string, config: GotifyConfig): Promise<void> {
  const url = config.url.replace(/\/$/, '')
  // Token in the X-Gotify-Key header, not the query string, so it stays out
  // of proxy/access logs and error messages that echo the URL.
  const res = await fetch(`${url}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Gotify-Key': config.token },
    redirect: 'error',
    body: JSON.stringify({ title, message, priority: config.priority ?? 5 }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`Gotify error: ${res.status}`)
}
