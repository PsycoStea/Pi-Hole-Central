#!/bin/sh
set -e

echo "Running database migrations..."
node -e "
const { migrate } = require('drizzle-orm/better-sqlite3/migrator')
const Database = require('better-sqlite3')
const { drizzle } = require('drizzle-orm/better-sqlite3')
const path = require('path')
const fs = require('fs')

const dbPath = process.env.DATABASE_URL?.replace('file:', '') ?? './data/pihole-central.db'
const dir = path.dirname(dbPath)
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

const sqlite = new Database(dbPath)
sqlite.pragma('journal_mode = WAL')
sqlite.pragma('foreign_keys = ON')
const db = drizzle(sqlite)
migrate(db, { migrationsFolder: './drizzle/migrations' })
console.log('Migrations complete')
"

echo "Seeding initial data..."
node -e "
const bcrypt = require('bcryptjs')
const { randomUUID } = require('crypto')
const Database = require('better-sqlite3')
const { drizzle } = require('drizzle-orm/better-sqlite3')

const dbPath = process.env.DATABASE_URL?.replace('file:', '') ?? './data/pihole-central.db'
const sqlite = new Database(dbPath)
sqlite.pragma('journal_mode = WAL')
const db = drizzle(sqlite)

// Check if admin already exists
const existing = sqlite.prepare('SELECT id FROM users WHERE username = ?').get('admin')
if (!existing) {
  const hash = bcrypt.hashSync('admin', 12)
  sqlite.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)').run(randomUUID(), 'admin', hash, Math.floor(Date.now() / 1000))
  console.log('Created admin user (password: admin)')
}

// Seed default alert settings
const types = ['offline', 'blocking_disabled', 'block_rate_low', 'recovery']
for (const type of types) {
  const exists = sqlite.prepare('SELECT id FROM alert_settings WHERE type = ?').get(type)
  if (!exists) {
    sqlite.prepare('INSERT INTO alert_settings (id, type, enabled, threshold, channel_ids_json) VALUES (?, ?, ?, ?, ?)').run(randomUUID(), type, 0, type === 'block_rate_low' ? 5 : null, '[]')
  }
}
console.log('Default alert settings ready')

// Seed default app settings
const retExists = sqlite.prepare(\"SELECT key FROM app_settings WHERE key = 'retention_days'\").get()
if (!retExists) {
  sqlite.prepare(\"INSERT INTO app_settings (key, value) VALUES ('retention_days', '30')\").run()
}
console.log('App settings ready')
"

exec node server.js
