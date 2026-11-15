import { isAllowedInstanceUrl } from '@/lib/pihole/validate'
import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { requireAdmin } from '@/lib/auth-guard'
import { db } from '@/lib/db'
import { instances } from '@/lib/db/schema'
import { encrypt } from '@/lib/crypto'
import { randomUUID } from 'crypto'
import { logAudit } from '@/lib/audit'

export async function GET() {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const rows = await db.query.instances.findMany()
  return NextResponse.json(
    rows.map(({ passwordEncrypted: _, sshPasswordEncrypted: __, ...r }) => r)
  )
}

export async function POST(req: Request) {
  const denied = await requireAdmin()
  if (denied) return denied

  const body = await req.json()
  const { name, url, password, sshUsername, sshPassword } = body
  if (!name || !url || !password) {
    return NextResponse.json({ error: 'name, url, and password are required' }, { status: 400 })
  }
  if (!isAllowedInstanceUrl(url)) {
    return NextResponse.json({ error: 'url must be http(s) on a private/LAN address or hostname' }, { status: 400 })
  }

  const instance = {
    id: randomUUID(),
    name,
    url: url.replace(/\/$/, ''),
    passwordEncrypted: encrypt(password),
    enabled: true,
    createdAt: new Date(),
    sshUsername: (sshUsername as string) || null,
    sshPasswordEncrypted: sshPassword ? encrypt(sshPassword as string) : null,
  }
  await db.insert(instances).values(instance)
  await logAudit('instance.add', instance.id, `${name} (${instance.url})`)
  const { passwordEncrypted: _, sshPasswordEncrypted: __, ...safe } = instance
  return NextResponse.json(safe, { status: 201 })
}
