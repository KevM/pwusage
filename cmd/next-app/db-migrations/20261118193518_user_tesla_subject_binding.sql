-- Migration: user_tesla_subject_binding
-- Created at: 2026-11-19T01:35:18Z

-- Record the Tesla subject (ID-token `sub`) each account belongs to, so an
-- account matched by email can only ever be taken over by its own subject.
-- Legacy rows keyed by email address get their subject from the first trusted
-- login that migrates them (bound atomically in UserRepo.upsertOnTeslaAuth).
-- No new table, so no RLS change: "User" keeps its existing policy.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS tesla_subject TEXT;

-- Every account created by a login that knew its subject is keyed by it. A
-- Tesla subject never contains '@'; ids that do are the legacy email-keyed rows
-- and stay unbound until their next trusted login.
UPDATE "User"
SET tesla_subject = id
WHERE tesla_subject IS NULL
  AND position('@' in id) = 0;

-- One account per Tesla subject.
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_tesla_subject
  ON "User" (tesla_subject)
  WHERE tesla_subject IS NOT NULL;
