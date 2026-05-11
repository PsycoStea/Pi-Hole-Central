import nodemailer from 'nodemailer'

export interface EmailConfig {
  host: string
  port: number
  user: string
  pass: string
  from: string
  to: string
  secure?: boolean
}

export async function send(title: string, message: string, config: EmailConfig): Promise<void> {
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: Number(config.port),
    secure: config.secure ?? Number(config.port) === 465,
    auth: { user: config.user, pass: config.pass },
  })
  await transporter.sendMail({
    from: config.from,
    to: config.to,
    subject: title,
    text: message,
  })
}
