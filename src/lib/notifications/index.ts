import { db } from '@/lib/db'
import { notificationChannels } from '@/lib/db/schema'
import { and, eq, inArray } from 'drizzle-orm'
import { decrypt } from '@/lib/crypto'
import * as gotify from './gotify'
import * as pushover from './pushover'
import * as telegram from './telegram'
import * as email from './email'
import { globalSingleton } from '@/lib/global-state'
import { errMsg } from '@/lib/errors'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const providers = { gotify, pushover, telegram, email } as unknown as Record<
  string,
  { send: (title: string, message: string, config: Record<string, unknown>) => Promise<void> }
>

// Pushes are delivered on their own queue and dispatch() returns at once.
// notify() runs inside the poll loop, so awaiting a send there let a slow or
// tarpitting SMTP/push server hold the poll mutex and delay offline detection
// and recovery (R3A-F2). Dispatches run one after another (channels within
// one dispatch in parallel); a burst beyond MAX_QUEUED is dropped and logged.
const MAX_QUEUED = 50
const sendQueue = globalSingleton('__piholeCentralSendQueue', () => ({
  tail: Promise.resolve() as Promise<void>,
  queued: 0,
}))

export async function dispatch(title: string, message: string, channelIds: string[]): Promise<void> {
  if (!channelIds.length) return
  if (sendQueue.queued >= MAX_QUEUED) {
    console.error(`[notifications] send queue full (${MAX_QUEUED}); dropped "${title}"`)
    return
  }
  sendQueue.queued++
  sendQueue.tail = sendQueue.tail
    .then(() => deliver(title, message, channelIds))
    .catch((err) => console.error(`[notifications] delivery error: ${errMsg(err)}`))
    .finally(() => {
      sendQueue.queued--
    })
}

async function deliver(title: string, message: string, channelIds: string[]): Promise<void> {
  const channels = await db.query.notificationChannels.findMany({
    where: and(
      inArray(notificationChannels.id, channelIds),
      eq(notificationChannels.enabled, true)
    ),
  })

  await Promise.allSettled(
    channels.map(async (ch) => {
      const provider = providers[ch.type]
      if (!provider) return
      try {
        const config = JSON.parse(decrypt(ch.configJson))
        await provider.send(title, message, config)
      } catch (err) {
        // One line, never the error object: fetch errors carry the request
        // URL, which for Telegram holds the bot token.
        console.error(`[notifications] Failed to send via ${ch.type} (${ch.label}): ${errMsg(err)}`)
      }
    })
  )
}

export async function sendTest(channelId: string): Promise<void> {
  const channel = await db.query.notificationChannels.findFirst({
    where: eq(notificationChannels.id, channelId),
  })
  if (!channel) throw new Error('Channel not found')
  const provider = providers[channel.type]
  if (!provider) throw new Error(`Unknown provider: ${channel.type}`)
  const config = JSON.parse(decrypt(channel.configJson))
  await provider.send('Pi-Hole Central — Test', 'This is a test notification from Pi-Hole Central.', config)
}
