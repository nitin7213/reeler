-- Counts read from Instagram's profile grid are rounded for display ("1.4m", "43.3k").
ALTER TABLE metric_snapshots ADD COLUMN IF NOT EXISTS approximate BOOLEAN NOT NULL DEFAULT false;
