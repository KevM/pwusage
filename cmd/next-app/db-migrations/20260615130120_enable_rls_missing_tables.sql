-- Migration: enable_rls_missing_tables
-- Created at: 2026-06-15T13:01:20Z

-- Enable Row Level Security (RLS) for BatteryHold
ALTER TABLE "BatteryHold" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "BatteryHold" FROM PUBLIC;
REVOKE ALL ON "BatteryHold" FROM anon;
REVOKE ALL ON "BatteryHold" FROM authenticated;
GRANT ALL ON "BatteryHold" TO service_role;
GRANT ALL ON SEQUENCE "BatteryHold_id_seq" TO service_role;

-- Enable Row Level Security (RLS) for EnergyRollup
ALTER TABLE "EnergyRollup" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "EnergyRollup" FROM PUBLIC;
REVOKE ALL ON "EnergyRollup" FROM anon;
REVOKE ALL ON "EnergyRollup" FROM authenticated;
GRANT ALL ON "EnergyRollup" TO service_role;

-- Enable Row Level Security (RLS) for SiteRoiConfig
ALTER TABLE "SiteRoiConfig" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "SiteRoiConfig" FROM PUBLIC;
REVOKE ALL ON "SiteRoiConfig" FROM anon;
REVOKE ALL ON "SiteRoiConfig" FROM authenticated;
GRANT ALL ON "SiteRoiConfig" TO service_role;

-- Enable Row Level Security (RLS) for RollupBackfill
ALTER TABLE "RollupBackfill" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "RollupBackfill" FROM PUBLIC;
REVOKE ALL ON "RollupBackfill" FROM anon;
REVOKE ALL ON "RollupBackfill" FROM authenticated;
GRANT ALL ON "RollupBackfill" TO service_role;
