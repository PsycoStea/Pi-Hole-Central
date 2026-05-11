export interface GotifyConfig {
  url: string
  token: string
  priority?: number
}

export async function send(title: string, message: string, config: GotifyConfig): Promise<void> {
  const url = config.url.replace(/\/$/, '')
  const res = await fetch(`${url}/message?token=${config.token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, message, priority: config.priority ?? 5 }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`Gotify error: ${res.status}`)
}
