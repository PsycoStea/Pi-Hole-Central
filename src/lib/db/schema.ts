import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core'

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role').notNull().default('admin'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

export const instances = sqliteTable('instances', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  url: text('url').notNull(),
  passwordEncrypted: text('password_encrypted').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

export const statsSnapshots = sqliteTable('stats_snapshots', {
  id: integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
  instanceId: text('instance_id')
    .notNull()
    .references(() => instances.id, { onDelete: 'cascade' }),
  timestamp: integer('timestamp', { mode: 'timestamp' }).notNull(),
  queriesToday: integer('queries_today').notNull(),
  blockedToday: integer('blocked_today').notNull(),
  blockPct: real('block_pct').notNull(),
  uniqueDomains: integer('unique_domains').notNull(),
  topDomainsJson: text('top_domains_json').notNull().default('[]'),
  topClientsJson: text('top_clients_json').notNull().default('[]'),
  status: text('status').notNull().default('online'),
})

export const notificationChannels = sqliteTable('notification_channels', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  label: text('label').notNull(),
  configJson: text('config_json').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
})

export const alertSettings = sqliteTable('alert_settings', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  threshold: real('threshold'),
  channelIdsJson: text('channel_ids_json').notNull().default('[]'),
})

export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
})
