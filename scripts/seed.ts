import bcrypt from 'bcryptjs'
import { randomUUID } from 'crypto'

process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'file:./data/pihole-central.db'

const { db } = await import('../src/lib/db/index.js')
const { users, alertSettings } = await import('../src/lib/db/schema.js')

// Seed admin user
const hash = await bcrypt.hash('admin', 12)
await db.insert(users).values({
  id: randomUUID(),
  username: 'admin',
  passwordHash: hash,
  createdAt: new Date(),
}).onConflictDoNothing()

// Seed default alert settings
const defaults = ['offline', 'blocking_disabled', 'block_rate_low', 'recovery'] as const
for (const type of defaults) {
  await db.insert(alertSettings).values({
    id: randomUUID(),
    type,
    enabled: false,
    threshold: type === 'block_rate_low' ? 5 : null,
    channelIdsJson: '[]',
  }).onConflictDoNothing()
}

console.log('✓ Seeded: admin user (password: admin) + default alert settings')
console.log('  Change the admin password after first login!')
