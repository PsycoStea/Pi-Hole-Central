ALTER TABLE instances ADD COLUMN ssh_username TEXT;
--> statement-breakpoint
ALTER TABLE instances ADD COLUMN ssh_password_encrypted TEXT;
--> statement-breakpoint
CREATE TABLE recovery_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  instance_id TEXT    NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  timestamp   INTEGER NOT NULL,
  event_type  TEXT    NOT NULL,
  detail      TEXT    NOT NULL DEFAULT '',
  success     INTEGER NOT NULL DEFAULT 1
);
--> statement-breakpoint
CREATE INDEX idx_recovery_instance_ts
  ON recovery_events(instance_id, timestamp DESC);
