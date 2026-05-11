export interface TelegramConfig {
  token: string
  chatId: string
}

export async function send(title: string, message: string, config: TelegramConfig): Promise<void> {
  const text = `*${title}*\n${message}`
  const res = await fetch(`https://api.telegram.org/bot${config.token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: config.chatId, text, parse_mode: 'Markdown' }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`Telegram error: ${res.status}`)
}
