-- Migration: battery_hold_monitoring
-- Created at: 2026-10-02T18:51:16.809Z

-- TODO: If this migration creates a new table, you MUST enable Row Level Security (RLS)!
-- ALTER TABLE "MyNewTable" ENABLE ROW LEVEL SECURITY;
-- REVOKE ALL ON "MyNewTable" FROM PUBLIC;
-- REVOKE ALL ON "MyNewTable" FROM anon;
-- REVOKE ALL ON "MyNewTable" FROM authenticated;
-- GRANT ALL ON "MyNewTable" TO service_role;
--
-- If using serial/sequence:
-- GRANT ALL ON SEQUENCE "MyNewTable_id_seq" TO service_role;

-- Existing table retains its RLS and grants. Existing holds start without a check.
ALTER TABLE "BatteryHold" ADD COLUMN IF NOT EXISTS monitoring jsonb;
