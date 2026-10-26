-- ReelScript AI: Reel ingest schema.
-- Metrics are stored as time-stamped snapshots per source so we never overwrite
-- a measured value with a missing one, and staleness can be computed per metric.

CREATE TABLE IF NOT EXISTS profiles (
  id                 BIGSERIAL PRIMARY KEY,
  username           TEXT NOT NULL UNIQUE,
  platform_user_id   TEXT,
  display_name       TEXT,
  is_private         BOOLEAN,
  reported_media_count INTEGER,          -- total posts the source says exist (all media types)
  last_discovered_at TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS import_jobs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id          BIGINT REFERENCES profiles(id) ON DELETE CASCADE,
  source_url          TEXT NOT NULL,
  discovery_provider  TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued','discovering','processing','completed','partial','failed')),
  -- Coverage honesty: what we found vs. what the source says exists.
  reels_discovered    INTEGER NOT NULL DEFAULT 0,
  coverage            TEXT NOT NULL DEFAULT 'unknown'
                      CHECK (coverage IN ('unknown','complete','partial','user_supplied')),
  coverage_notes      TEXT[] NOT NULL DEFAULT '{}',
  options             JSONB NOT NULL DEFAULT '{}',
  error               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at         TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS import_jobs_profile_idx ON import_jobs(profile_id, created_at DESC);

CREATE TABLE IF NOT EXISTS reels (
  id               BIGSERIAL PRIMARY KEY,
  profile_id       BIGINT REFERENCES profiles(id) ON DELETE CASCADE,
  shortcode        TEXT NOT NULL UNIQUE,
  url              TEXT NOT NULL,
  platform_media_id TEXT,
  owner_username   TEXT,
  caption          TEXT,
  published_at     TIMESTAMPTZ,
  duration_seconds NUMERIC(10,3),
  has_audio        BOOLEAN,
  first_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 'available' | 'unavailable' (deleted / private / removed)
  availability     TEXT NOT NULL DEFAULT 'available',
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reels_profile_idx ON reels(profile_id, published_at DESC);

-- Per-import, per-reel processing state. One row per (job, reel) so retries
-- of the same import never duplicate work items.
CREATE TABLE IF NOT EXISTS reel_tasks (
  import_job_id    UUID NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
  reel_id          BIGINT NOT NULL REFERENCES reels(id) ON DELETE CASCADE,
  stage            TEXT NOT NULL DEFAULT 'queued'
                   CHECK (stage IN ('queued','fetching','extracting_audio','transcribing','done','failed','skipped')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  error_kind       TEXT,
  error            TEXT,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (import_job_id, reel_id)
);
CREATE INDEX IF NOT EXISTS reel_tasks_stage_idx ON reel_tasks(import_job_id, stage);

CREATE TABLE IF NOT EXISTS metric_snapshots (
  id            BIGSERIAL PRIMARY KEY,
  reel_id       BIGINT NOT NULL REFERENCES reels(id) ON DELETE CASCADE,
  source        TEXT NOT NULL,
  collected_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- NULL means "the source did not provide this", never zero.
  views         BIGINT,
  plays         BIGINT,
  likes         BIGINT,
  comments      BIGINT,
  metrics_hidden BOOLEAN            -- owner hid like/view counts
);
CREATE INDEX IF NOT EXISTS metric_snapshots_reel_idx ON metric_snapshots(reel_id, collected_at DESC);

CREATE TABLE IF NOT EXISTS audio_assets (
  reel_id          BIGINT PRIMARY KEY REFERENCES reels(id) ON DELETE CASCADE,
  provider         TEXT NOT NULL,
  sha256           TEXT NOT NULL,
  path             TEXT NOT NULL,       -- normalized 16 kHz mono WAV
  duration_seconds NUMERIC(10,3),
  bytes            BIGINT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audio_assets_sha_idx ON audio_assets(sha256);

-- Cache key is (audio sha256, provider, model): identical audio is never
-- transcribed (or paid for) twice, even across reels.
CREATE TABLE IF NOT EXISTS transcripts (
  id                BIGSERIAL PRIMARY KEY,
  audio_sha256      TEXT NOT NULL,
  provider          TEXT NOT NULL,
  model             TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('completed','no_speech','failed')),
  language          TEXT,
  language_probability NUMERIC(5,4),
  text              TEXT,
  segments          JSONB,              -- [{start,end,text}] seconds
  error             TEXT,
  processing_ms     INTEGER,
  cost_usd          NUMERIC(12,6) NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (audio_sha256, provider, model)
);

CREATE TABLE IF NOT EXISTS cost_events (
  id             BIGSERIAL PRIMARY KEY,
  import_job_id  UUID REFERENCES import_jobs(id) ON DELETE SET NULL,
  reel_id        BIGINT REFERENCES reels(id) ON DELETE SET NULL,
  provider       TEXT NOT NULL,
  operation      TEXT NOT NULL,          -- discovery | audio | transcription
  units          NUMERIC(14,4) NOT NULL,
  unit           TEXT NOT NULL,          -- requests | results | audio_minutes
  cost_usd       NUMERIC(12,6) NOT NULL DEFAULT 0,
  cached         BOOLEAN NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cost_events_job_idx ON cost_events(import_job_id);
