-- English translation alongside the original-language transcript.
ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS text_en TEXT;
ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS segments_en JSONB;

-- Per-reel timings, used to estimate time remaining for an import.
ALTER TABLE reel_tasks ADD COLUMN IF NOT EXISTS fetch_ms INTEGER;
ALTER TABLE reel_tasks ADD COLUMN IF NOT EXISTS transcribe_ms INTEGER;
ALTER TABLE reel_tasks ADD COLUMN IF NOT EXISTS transcript_cached BOOLEAN;
