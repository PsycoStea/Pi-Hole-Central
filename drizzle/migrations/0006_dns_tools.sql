CREATE TABLE IF NOT EXISTS dns_schedules (
  id                TEXT    PRIMARY KEY NOT NULL,
  name              TEXT    NOT NULL,
  enabled           INTEGER NOT NULL DEFAULT 1,
  target_type       TEXT    NOT NULL DEFAULT 'blocking',
  target_group      TEXT,
  instance_ids_json TEXT    NOT NULL DEFAULT '[]',
  days_json         TEXT    NOT NULL DEFAULT '[0,1,2,3,4,5,6]',
  start_time        TEXT    NOT NULL,
  end_time          TEXT    NOT NULL,
  window_state      INTEGER NOT NULL DEFAULT 1,
  created_at        INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS temp_allows (
  id          TEXT    PRIMARY KEY NOT NULL,
  instance_id TEXT    NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  domain      TEXT    NOT NULL,
  kind        TEXT    NOT NULL DEFAULT 'exact',
  list        TEXT    NOT NULL DEFAULT 'allow',
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  reverted    INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_temp_allows_expires
  ON temp_allows(reverted, expires_at);
