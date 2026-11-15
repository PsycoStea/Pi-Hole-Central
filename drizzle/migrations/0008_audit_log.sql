CREATE TABLE IF NOT EXISTS audit_log (
  id        TEXT    PRIMARY KEY NOT NULL,
  timestamp INTEGER NOT NULL,
  user_id   TEXT    NOT NULL DEFAULT '',
  username  TEXT    NOT NULL DEFAULT '',
  action    TEXT    NOT NULL,
  target    TEXT    NOT NULL DEFAULT '',
  detail    TEXT    NOT NULL DEFAULT '',
  ip        TEXT    NOT NULL DEFAULT ''
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_audit_ts
  ON audit_log(timestamp DESC);
