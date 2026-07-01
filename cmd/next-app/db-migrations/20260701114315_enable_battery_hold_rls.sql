-- Migration: enable_battery_hold_rls
-- Created at: 2026-07-01T16:43:15Z

-- Enable Row Level Security (RLS) for BatteryHold
ALTER TABLE "BatteryHold" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "BatteryHold" FROM PUBLIC;
REVOKE ALL ON "BatteryHold" FROM anon;
REVOKE ALL ON "BatteryHold" FROM authenticated;
GRANT ALL ON "BatteryHold" TO service_role;
GRANT ALL ON SEQUENCE "BatteryHold_id_seq" TO service_role;
