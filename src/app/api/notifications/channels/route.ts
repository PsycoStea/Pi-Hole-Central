import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { requireAdmin } from '@/lib/auth-guard'
import { db } from '@/lib/db'
import { notificationChannels } from '@/lib/db/schema'
import { encrypt } from '@/lib/crypto'
import { randomUUID } from 'crypto'

export async function GET() {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const channels = await db.query.notificationChannels.findMany()
  return NextResponse.json(channels.map(({ configJson: _, ...c }) => c))
}

export async function POST(req: Request) {
  const denied = await requireAdmin()
  if (denied) return denied
  const { type, label, config } = await req.json()
  if (!type || !label || !config) {
    return NextResponse.json({ error: 'type, label, and config required' }, { status: 400 })
  }
  const channel = {
    id: randomUUID(),
    type,
    label,
    configJson: encrypt(JSON.stringify(config)),
    enabled: true,
  }
  await db.insert(notificationChannels).values(channel)
  const { configJson: _, ...safe } = channel
  return NextResponse.json(safe, { status: 201 })
}
