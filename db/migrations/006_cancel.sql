-- Imports can be stopped by the user; remaining reels are marked skipped with error_kind 'cancelled'.
ALTER TABLE import_jobs DROP CONSTRAINT IF EXISTS import_jobs_status_check;
ALTER TABLE import_jobs ADD CONSTRAINT import_jobs_status_check
  CHECK (status IN ('queued','discovering','processing','completed','partial','failed','cancelled'));
