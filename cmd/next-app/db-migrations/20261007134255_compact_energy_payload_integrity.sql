-- Migration: compact_energy_payload_integrity
-- Created at: 2026-10-07T18:42:55.574Z

-- TODO: If this migration creates a new table, you MUST enable Row Level Security (RLS)!
-- ALTER TABLE "MyNewTable" ENABLE ROW LEVEL SECURITY;
-- REVOKE ALL ON "MyNewTable" FROM PUBLIC;
-- REVOKE ALL ON "MyNewTable" FROM anon;
-- REVOKE ALL ON "MyNewTable" FROM authenticated;
-- GRANT ALL ON "MyNewTable" TO service_role;
--
-- If using serial/sequence:
-- GRANT ALL ON SEQUENCE "MyNewTable_id_seq" TO service_role;

-- Existing archive RLS applies. No backfill: retained raw data supports verified upgrades.
ALTER TABLE "EnergyDayArchive" ADD COLUMN payload_checksum text CHECK (payload_checksum IS NULL OR payload_checksum ~ '^[0-9a-f]{64}$');
