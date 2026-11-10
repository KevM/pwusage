-- Migration: add_memberships_attempted_at
-- Created at: 2026-11-09T21:04:59.419Z

-- TODO: If this migration creates a new table, you MUST enable Row Level Security (RLS)!
-- ALTER TABLE "MyNewTable" ENABLE ROW LEVEL SECURITY;
-- REVOKE ALL ON "MyNewTable" FROM PUBLIC;
-- REVOKE ALL ON "MyNewTable" FROM anon;
-- REVOKE ALL ON "MyNewTable" FROM authenticated;
-- GRANT ALL ON "MyNewTable" TO service_role;
--
-- If using serial/sequence:
-- GRANT ALL ON SEQUENCE "MyNewTable_id_seq" TO service_role;

-- Daily membership reconciliation picks the least recently attempted accounts, so
-- accounts whose Tesla grant keeps failing rotate to the back instead of
-- monopolizing the batch. memberships_checked_at still means "last success".
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS memberships_attempted_at TIMESTAMPTZ;
