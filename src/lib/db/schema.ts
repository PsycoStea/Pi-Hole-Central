import { sqliteTable, text, integer, real, index } from 'drizzle-orm/sqlite-core'

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role').notNull().default('viewer'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  // Copied into the JWT at sign-in and compared on every session read; bumping
  // it ends all of this user's sessions (migration 0010, audit R1-F1).
  tokenVersion: integer('token_version').notNull().default(0),
})

export const instances = sqliteTable('instances', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  url: text('url').notNull(),
  passwordEncrypted: text('password_encrypted').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  sshUsername: text('ssh_username'),
  sshPasswordEncrypted: text('ssh_password_encrypted'),
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
}, (t) => [
  index('idx_stats_instance_ts').on(t.instanceId, t.timestamp),
])

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
  // `enabled` = this alert type generates an in-app notification.
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  threshold: real('threshold'),
  channelIdsJson: text('channel_ids_json').notNull().default('[]'),
  // Optional outbound push: only push to channels when push_enabled AND the
  // notification's severity is >= min_push_severity.
  pushEnabled: integer('push_enabled', { mode: 'boolean' }).notNull().default(false),
  minPushSeverity: text('min_push_severity').notNull().default('warning'),
})

export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
})

export const notifications = sqliteTable('notifications', {
  id: integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
  type: text('type').notNull(),
  severity: text('severity').notNull().default('info'), // info | warning | critical
  title: text('title').notNull(),
  message: text('message').notNull().default(''),
  // Nullable, and set-null on instance delete so the feed survives instance removal.
  instanceId: text('instance_id').references(() => instances.id, { onDelete: 'set null' }),
  read: integer('read', { mode: 'boolean' }).notNull().default(false),
  pushed: integer('pushed', { mode: 'boolean' }).notNull().default(false),
  timestamp: integer('timestamp', { mode: 'timestamp' }).notNull(),
  // Sticky rows represent an ongoing CONDITION rather than a point-in-time
  // event: one live row per (type, instanceId), updated in place while the
  // condition holds. `resolvedAt` is null exactly while it is still true.
  sticky: integer('sticky', { mode: 'boolean' }).notNull().default(false),
  raisedAt: integer('raised_at', { mode: 'timestamp' }),
  resolvedAt: integer('resolved_at', { mode: 'timestamp' }),
}, (t) => [
  index('idx_notifications_ts').on(t.timestamp),
  index('idx_notifications_read_ts').on(t.read, t.timestamp),
  index('idx_notifications_live').on(t.sticky, t.resolvedAt, t.type, t.instanceId),
])

export const dnsSchedules = sqliteTable('dns_schedules', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  // 'blocking' = whole-node ad blocking; 'group' = a Pi-hole group's enabled flag
  targetType: text('target_type').notNull().default('blocking'),
  targetGroup: text('target_group'), // group name when targetType='group'
  instanceIdsJson: text('instance_ids_json').notNull().default('[]'),
  daysJson: text('days_json').notNull().default('[0,1,2,3,4,5,6]'), // 0=Sun..6=Sat
  startTime: text('start_time').notNull(), // 'HH:MM' (local tz)
  endTime: text('end_time').notNull(), // 'HH:MM'
  // Desired target state DURING the window; outside the window it is the opposite.
  // For 'blocking': true = blocking enabled. For 'group': true = group enabled.
  windowState: integer('window_state', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

export const tempAllows = sqliteTable('temp_allows', {
  id: text('id').primaryKey(),
  instanceId: text('instance_id')
    .notNull()
    .references(() => instances.id, { onDelete: 'cascade' }),
  domain: text('domain').notNull(),
  kind: text('kind').notNull().default('exact'), // exact | regex
  list: text('list').notNull().default('allow'), // allow | deny
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  reverted: integer('reverted', { mode: 'boolean' }).notNull().default(false),
}, (t) => [
  index('idx_temp_allows_expires').on(t.reverted, t.expiresAt),
])

export const backupHistory = sqliteTable('backup_history', {
  id: text('id').primaryKey(),
  instanceId: text('instance_id')
    .notNull()
    .references(() => instances.id, { onDelete: 'cascade' }),
  filename: text('filename').notNull().default(''),
  sizeBytes: integer('size_bytes').notNull().default(0),
  trigger: text('trigger').notNull().default('manual'), // manual | scheduled
  success: integer('success', { mode: 'boolean' }).notNull().default(true),
  note: text('note').notNull().default(''),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, (t) => [
  index('idx_backup_instance_ts').on(t.instanceId, t.createdAt),
])

export const auditLog = sqliteTable('audit_log', {
  id: text('id').primaryKey(),
  timestamp: integer('timestamp', { mode: 'timestamp' }).notNull(),
  userId: text('user_id').notNull().default(''),
  username: text('username').notNull().default(''),
  action: text('action').notNull(),
  target: text('target').notNull().default(''),
  detail: text('detail').notNull().default(''),
  ip: text('ip').notNull().default(''),
}, (t) => [
  index('idx_audit_ts').on(t.timestamp),
])

export const recoveryEvents = sqliteTable('recovery_events', {
  id: integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
  instanceId: text('instance_id')
    .notNull()
    .references(() => instances.id, { onDelete: 'cascade' }),
  timestamp: integer('timestamp', { mode: 'timestamp' }).notNull(),
  eventType: text('event_type').notNull(),
  detail: text('detail').notNull().default(''),
  success: integer('success', { mode: 'boolean' }).notNull().default(true),
}, (t) => [
  index('idx_recovery_instance_ts').on(t.instanceId, t.timestamp),
])

// Per-node operation lock (migration 0011, audit P5.2 / R2-NV3). One row per
// node at most: an update, gravity run, Teleporter export, recovery loop or
// watchdog restart holds it, and everything else that would touch the node's
// FTL checks it first. Rows expire on their own (expires_at) so a crashed
// holder can never wedge a node; acquisition is a single atomic statement in
// src/lib/ops/node-lock.ts.
export const nodeLocks = sqliteTable('node_locks', {
  instanceId: text('instance_id')
    .primaryKey()
    .references(() => instances.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  token: text('token').notNull(),
  startedAt: integer('started_at').notNull(), // ms epoch
  expiresAt: integer('expires_at').notNull(), // ms epoch
})

// Automated-recovery budget and latches, persisted so an app restart does not
// re-arm them (migration 0011, audit P5.4 / R2-F8). state_json holds the
// in-memory RecoveryState minus inProgress; it is cleared by a successful
// poll. last_reboot_at survives that clear: it is the 1-reboot-per-24h budget.
export const recoveryState = sqliteTable('recovery_state', {
  instanceId: text('instance_id')
    .primaryKey()
    .references(() => instances.id, { onDelete: 'cascade' }),
  stateJson: text('state_json'),
  lastRebootAt: integer('last_reboot_at'), // ms epoch
  updatedAt: integer('updated_at').notNull(), // ms epoch
})
