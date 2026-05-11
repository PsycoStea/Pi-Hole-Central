import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { instances } from '@/lib/db/schema'
import { encrypt } from '@/lib/crypto'
import { randomUUID } from 'crypto'

export async function GET() {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const rows = await db.query.instances.findMany()
  return NextResponse.json(rows.map(({ passwordEncrypted: _, ...r }) => r))
}

export async function POST(req: Request) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  const { name, url, password } = body
  if (!name || !url || !password) {
    return NextResponse.json({ error: 'name, url, and password are required' }, { status: 400 })
  }

  const instance = {
    id: randomUUID(),
    name,
    url: url.replace(/\/$/, ''),
    passwordEncrypted: encrypt(password),
    enabled: true,
    createdAt: new Date(),
  }
  await db.insert(instances).values(instance)
  const { passwordEncrypted: _, ...safe } = instance
  return NextResponse.json(safe, { status: 201 })
}
