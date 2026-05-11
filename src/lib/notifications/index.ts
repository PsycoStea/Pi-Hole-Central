import { db } from '@/lib/db'
import { notificationChannels } from '@/lib/db/schema'
import { and, eq, inArray } from 'drizzle-orm'
import { decrypt } from '@/lib/crypto'
import * as gotify from './gotify'
import * as pushover from './pushover'
import * as telegram from './telegram'
import * as email from './email'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const providers = { gotify, pushover, telegram, email } as unknown as Record<
  string,
  { send: (title: string, message: string, config: Record<string, unknown>) => Promise<void> }
>

export async function dispatch(title: string, message: string, channelIds: string[]): Promise<void> {
  if (!channelIds.length) return

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
        console.error(`[notifications] Failed to send via ${ch.type} (${ch.label}):`, err)
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
