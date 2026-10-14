-- Migration: battery_hold_monitor_claim
-- Created at: 2026-10-14T18:33:44.349Z

-- TODO: If this migration creates a new table, you MUST enable Row Level Security (RLS)!
-- ALTER TABLE "MyNewTable" ENABLE ROW LEVEL SECURITY;
-- REVOKE ALL ON "MyNewTable" FROM PUBLIC;
-- REVOKE ALL ON "MyNewTable" FROM anon;
-- REVOKE ALL ON "MyNewTable" FROM authenticated;
-- GRANT ALL ON "MyNewTable" TO service_role;
--
-- If using serial/sequence:
-- GRANT ALL ON SEQUENCE "MyNewTable_id_seq" TO service_role;

-- Reuse the authoritative lifecycle row; do not introduce monitor jobs.
ALTER TABLE "BatteryHold"
  ADD COLUMN processing_owner uuid,
  ADD COLUMN processing_expires_at timestamptz,
  ADD COLUMN restore_attempted_at timestamptz;
