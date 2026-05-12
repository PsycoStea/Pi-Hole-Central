CREATE INDEX IF NOT EXISTS idx_stats_instance_ts ON stats_snapshots(instance_id, timestamp DESC);
