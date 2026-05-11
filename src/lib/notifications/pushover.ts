export interface PushoverConfig {
  token: string
  user: string
}

export async function send(title: string, message: string, config: PushoverConfig): Promise<void> {
  const res = await fetch('https://api.pushover.net/1/messages.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: config.token, user: config.user, title, message }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`Pushover error: ${res.status}`)
}
