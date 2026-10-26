-- Separate "waiting for a transcription slot" from "transcribing now", and record
-- when transcription starts so the time-remaining estimate can count down.
ALTER TABLE reel_tasks DROP CONSTRAINT IF EXISTS reel_tasks_stage_check;
ALTER TABLE reel_tasks ADD CONSTRAINT reel_tasks_stage_check
  CHECK (stage IN ('queued','fetching','extracting_audio','waiting_transcription','transcribing','done','failed','skipped'));
ALTER TABLE reel_tasks ADD COLUMN IF NOT EXISTS transcribe_started_at TIMESTAMPTZ;
