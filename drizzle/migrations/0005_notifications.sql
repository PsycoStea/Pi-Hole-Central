CREATE TABLE IF NOT EXISTS notifications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  type        TEXT    NOT NULL,
  severity    TEXT    NOT NULL DEFAULT 'info',
  title       TEXT    NOT NULL,
  message     TEXT    NOT NULL DEFAULT '',
  instance_id TEXT    REFERENCES instances(id) ON DELETE SET NULL,
  read        INTEGER NOT NULL DEFAULT 0,
  pushed      INTEGER NOT NULL DEFAULT 0,
  timestamp   INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_notifications_ts
  ON notifications(timestamp DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_notifications_read_ts
  ON notifications(read, timestamp DESC);
--> statement-breakpoint
ALTER TABLE alert_settings ADD COLUMN push_enabled INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE alert_settings ADD COLUMN min_push_severity TEXT NOT NULL DEFAULT 'warning';
