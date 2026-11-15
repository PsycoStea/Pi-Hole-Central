#!/bin/sh
set -e

# The DB holds encrypted node passwords and the backups hold full Teleporter
# exports: keep everything the app writes owner-only (it runs as root).
umask 077
DB_FILE=${DATABASE_URL#file:}
DATA_DIR=$(dirname "${DB_FILE:-./data/pihole-central.db}")
mkdir -p "$DATA_DIR"
chmod -R go-rwx "$DATA_DIR"

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

// Create the default login only on a brand-new database (no users at all).
// It used to check for a user literally named 'admin', so renaming or
// deleting that account brought admin/admin back on the next restart.
const userCount = sqlite.prepare('SELECT COUNT(*) AS n FROM users').get().n
if (userCount === 0) {
  const hash = bcrypt.hashSync('admin', 12)
  sqlite.prepare('INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)').run(randomUUID(), 'admin', hash, 'admin', Math.floor(Date.now() / 1000))
  console.log('=========================================')
  console.log('  DEFAULT CREDENTIALS CREATED:')
  console.log('  Username: admin')
  console.log('  Password: admin')
  console.log('  CHANGE THIS PASSWORD IMMEDIATELY')
  console.log('  Settings -> Account -> Change Password')
  console.log('=========================================')
}

// Seed default alert settings.
// Original alert types default to disabled (opt-in, unchanged behaviour).
const types = ['offline', 'blocking_disabled', 'block_rate_low', 'recovery']
for (const type of types) {
  const exists = sqlite.prepare('SELECT id FROM alert_settings WHERE type = ?').get(type)
  if (!exists) {
    sqlite.prepare('INSERT INTO alert_settings (id, type, enabled, threshold, channel_ids_json) VALUES (?, ?, ?, ?, ?)').run(randomUUID(), type, 0, type === 'block_rate_low' ? 5 : null, '[]')
  }
}
// Infra + watchdog types feed the in-app notification centre by default
// (enabled=1), with outbound push off until the user configures channels.
const inAppTypes = ['sd_health', 'cert_expiry', 'latency_high', 'watchdog_restart', 'nebula_sync_drift', 'ssh_host_key', 'unbound_down', 'node_tls_cert']
for (const type of inAppTypes) {
  const exists = sqlite.prepare('SELECT id FROM alert_settings WHERE type = ?').get(type)
  if (!exists) {
    sqlite.prepare('INSERT INTO alert_settings (id, type, enabled, threshold, channel_ids_json, push_enabled, min_push_severity) VALUES (?, ?, ?, ?, ?, ?, ?)').run(randomUUID(), type, 1, null, '[]', 0, 'warning')
  }
}
console.log('Default alert settings ready')

// Seed default app settings
const retExists = sqlite.prepare(\"SELECT key FROM app_settings WHERE key = 'retention_days'\").get()
if (!retExists) {
  sqlite.prepare(\"INSERT INTO app_settings (key, value) VALUES ('retention_days', '30')\").run()
}
const pollExists = sqlite.prepare(\"SELECT key FROM app_settings WHERE key = 'poll_interval_seconds'\").get()
if (!pollExists) {
  sqlite.prepare(\"INSERT INTO app_settings (key, value) VALUES ('poll_interval_seconds', '300')\").run()
}
const statsExists = sqlite.prepare(\"SELECT key FROM app_settings WHERE key = 'stats_interval_seconds'\").get()
if (!statsExists) {
  sqlite.prepare(\"INSERT INTO app_settings (key, value) VALUES ('stats_interval_seconds', '300')\").run()
}
const updateCheckExists = sqlite.prepare(\"SELECT key FROM app_settings WHERE key = 'update_check_interval'\").get()
if (!updateCheckExists) {
  sqlite.prepare(\"INSERT INTO app_settings (key, value) VALUES ('update_check_interval', 'daily')\").run()
}
console.log('App settings ready')
"

exec node server.js
