import nodemailer from 'nodemailer'

export interface EmailConfig {
  host: string
  port: number
  user: string
  pass: string
  from: string
  to: string
  secure?: boolean
  // 'starttls' (default; the upgrade is REQUIRED), 'implicit' (TLS from the
  // first byte, usually port 465) or 'none' (plain, only without a login).
  tls?: 'starttls' | 'implicit' | 'none' | ''
}

// A tarpit or dead SMTP server used to hang a send for minutes (R3A-F2).
const CONNECT_TIMEOUT_MS = 10_000
const GREETING_TIMEOUT_MS = 10_000
const SOCKET_TIMEOUT_MS = 15_000

export function tlsMode(config: EmailConfig): 'starttls' | 'implicit' | 'none' {
  if (config.tls === 'starttls' || config.tls === 'implicit' || config.tls === 'none') return config.tls
  return config.secure ?? Number(config.port) === 465 ? 'implicit' : 'starttls'
}

export async function send(title: string, message: string, config: EmailConfig): Promise<void> {
  const mode = tlsMode(config)
  const hasLogin = !!(config.user || config.pass)
  // Without requireTLS, nodemailer sends AUTH in clear text when the server
  // (or anyone on the path) leaves STARTTLS out of its EHLO reply (R3A-F3).
  if (mode === 'none' && hasLogin) {
    throw new Error('Refusing to send the SMTP login without TLS (set TLS to starttls or implicit)')
  }
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: Number(config.port),
    secure: mode === 'implicit',
    requireTLS: mode === 'starttls',
    ignoreTLS: mode === 'none',
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: GREETING_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
    ...(hasLogin ? { auth: { user: config.user, pass: config.pass } } : {}),
  })
  try {
    await transporter.sendMail({
      from: config.from,
      to: config.to,
      subject: title,
      text: message,
    })
  } finally {
    transporter.close()
  }
}
