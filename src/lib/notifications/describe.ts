// Non-secret description of where a notification channel sends, for the audit
// log. Tokens, passwords and user keys are never included: only which secret
// fields changed.
const PUBLIC_FIELDS = ['url', 'host', 'port', 'secure', 'from', 'to', 'chatId', 'priority'] as const
const SECRET_FIELDS = ['token', 'pass', 'user'] as const

type Config = Record<string, unknown>

export function describeChannelConfig(config: Config): string {
  return PUBLIC_FIELDS.filter((k) => config[k] !== undefined && config[k] !== '')
    .map((k) => `${k}=${String(config[k])}`)
    .join(' ')
}

export function diffChannelConfig(before: Config, after: Config): string {
  const out: string[] = []
  for (const k of PUBLIC_FIELDS) {
    if (String(before[k] ?? '') !== String(after[k] ?? '')) {
      out.push(`${k}: ${JSON.stringify(before[k] ?? '')} -> ${JSON.stringify(after[k] ?? '')}`)
    }
  }
  for (const k of SECRET_FIELDS) {
    if (String(before[k] ?? '') !== String(after[k] ?? '')) out.push(`${k} changed`)
  }
  return out.join('; ')
}
