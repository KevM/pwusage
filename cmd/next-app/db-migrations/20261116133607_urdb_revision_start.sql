-- Migration: urdb_revision_start
-- Created at: 2026-11-16T19:36:07.710Z

-- TODO: If this migration creates a new table, you MUST enable Row Level Security (RLS)!
-- ALTER TABLE "MyNewTable" ENABLE ROW LEVEL SECURITY;
-- REVOKE ALL ON "MyNewTable" FROM PUBLIC;
-- REVOKE ALL ON "MyNewTable" FROM anon;
-- REVOKE ALL ON "MyNewTable" FROM authenticated;
-- GRANT ALL ON "MyNewTable" TO service_role;
--
-- If using serial/sequence:
-- GRANT ALL ON SEQUENCE "MyNewTable_id_seq" TO service_role;
-- The URDB revision's own start date for estimated rows. start_date is the span clipped to the
-- site's history, so freshness ("may be out of date") reads this column instead.
ALTER TABLE "TariffUrdbSource" ADD COLUMN IF NOT EXISTS revision_start DATE;
