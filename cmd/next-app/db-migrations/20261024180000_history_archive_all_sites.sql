-- Let the history archive job archive every owned site without listing it.
--
-- archive_all=true: the job finalizes finished days (past HISTORY_ARCHIVE_AFTER_DAYS)
-- for every site with an owner, so new sites are picked up automatically.
-- site_ids (with from_date/before_date) stays the explicit cohort that trim mode
-- deletes raw rows for, so trimming can still roll out one site at a time.
-- Defaults keep the job's current behavior; activation is an operator step
-- (scripts/control-history-archive.ts archive-all).
ALTER TABLE "HistoryArchiveControl" ADD COLUMN IF NOT EXISTS archive_all boolean NOT NULL DEFAULT false;
