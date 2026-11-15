CREATE TABLE IF NOT EXISTS backup_history (
  id          TEXT    PRIMARY KEY NOT NULL,
  instance_id TEXT    NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  filename    TEXT    NOT NULL DEFAULT '',
  size_bytes  INTEGER NOT NULL DEFAULT 0,
  trigger     TEXT    NOT NULL DEFAULT 'manual',
  success     INTEGER NOT NULL DEFAULT 1,
  note        TEXT    NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_backup_instance_ts
  ON backup_history(instance_id, created_at DESC);
