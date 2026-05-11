import { auth } from '@/lib/auth'
import * as piholeClient from '@/lib/pihole/client'
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

function bucketData(
  rows: { timestamp: number; blocked: number; total: number }[],
  bucketSeconds: number
) {
  const buckets = new Map<number, { blocked: number; total: number }>()
  for (const row of rows) {
    const bucket = Math.floor(row.timestamp / bucketSeconds) * bucketSeconds
    const existing = buckets.get(bucket) ?? { blocked: 0, total: 0 }
    buckets.set(bucket, {
      blocked: existing.blocked + row.blocked,
      total: existing.total + row.total,
    })
  }
  return Array.from(buckets.entries())
    .map(([timestamp, v]) => ({ timestamp, ...v }))
    .sort((a, b) => a.timestamp - b.timestamp)
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const url = new URL(req.url)
  const hours = parseInt(url.searchParams.get('hours') ?? '24', 10)

  const to = Math.floor(Date.now() / 1000)
  const from = to - hours * 3600

  try {
    const raw = await piholeClient.getQueryHistory(id, from, to)

    // Bucket size: 10-min for 24h, 1-hour for 7d, 6-hour for 30d
    let bucketSeconds = 600
    if (hours > 168) bucketSeconds = 21600
    else if (hours > 24) bucketSeconds = 3600

    const data = hours === 24 ? raw : bucketData(raw, bucketSeconds)

    return NextResponse.json({ data })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 })
  }
}
