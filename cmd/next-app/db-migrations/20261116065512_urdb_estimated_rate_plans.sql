-- Migration: urdb_estimated_rate_plans
-- Created at: 2026-11-16T12:55:12.468Z

-- TODO: If this migration creates a new table, you MUST enable Row Level Security (RLS)!
-- ALTER TABLE "MyNewTable" ENABLE ROW LEVEL SECURITY;
-- REVOKE ALL ON "MyNewTable" FROM PUBLIC;
-- REVOKE ALL ON "MyNewTable" FROM anon;
-- REVOKE ALL ON "MyNewTable" FROM authenticated;
-- GRANT ALL ON "MyNewTable" TO service_role;
--
-- If using serial/sequence:
-- GRANT ALL ON SEQUENCE "MyNewTable_id_seq" TO service_role;

ALTER TABLE "Tariff" ADD COLUMN IF NOT EXISTS plan_name TEXT, ADD COLUMN IF NOT EXISTS plan_code TEXT;
ALTER TABLE "Tariff" DROP CONSTRAINT IF EXISTS tariff_source_check;
ALTER TABLE "Tariff" ADD CONSTRAINT tariff_source_check CHECK (source IN ('tesla', 'manual', 'estimated'));
ALTER TABLE "TariffEffectivePeriod" DROP CONSTRAINT IF EXISTS "TariffEffectivePeriod_source_check";
ALTER TABLE "TariffEffectivePeriod" ADD CONSTRAINT "TariffEffectivePeriod_source_check" CHECK (source IN ('tesla', 'manual', 'estimated'));
ALTER TABLE "TariffReferencePeriod" ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE "TariffReferencePeriod" DROP CONSTRAINT IF EXISTS tariff_reference_period_source_check;
ALTER TABLE "TariffReferencePeriod" ADD CONSTRAINT tariff_reference_period_source_check CHECK (source IN ('manual', 'estimated'));

CREATE TABLE IF NOT EXISTS "SiteUtility" (
  site_id TEXT PRIMARY KEY REFERENCES "Site"(id) ON DELETE CASCADE,
  urdb_utility TEXT,
  choice TEXT NOT NULL CHECK (choice IN ('auto', 'owner', 'skipped')),
  urdb_plan_label TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'ready', 'needs_utility', 'needs_plan', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  checked_at TIMESTAMPTZ,
  next_check_at TIMESTAMPTZ,
  updated_by_user_id TEXT REFERENCES "User"(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS "TariffUrdbSource" (
  tariff_id INTEGER PRIMARY KEY REFERENCES "Tariff"(id) ON DELETE CASCADE,
  site_id TEXT NOT NULL REFERENCES "Site"(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('tesla_anchor', 'estimated_actual', 'estimated_reference')),
  urdb_label TEXT,
  start_date DATE NOT NULL,
  end_date DATE,
  start_source TEXT NOT NULL CHECK (start_source IN ('urdb', 'tesla_first_seen', 'assumed_jan_1', 'history_start')),
  newer_urdb_label TEXT,
  newer_urdb_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tariff_urdb_source_site_role_idx ON "TariffUrdbSource" (site_id, role);
ALTER TABLE "SiteUtility" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "SiteUtility" FROM PUBLIC, anon, authenticated;
GRANT ALL ON "SiteUtility" TO service_role;
ALTER TABLE "TariffUrdbSource" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "TariffUrdbSource" FROM PUBLIC, anon, authenticated;
GRANT ALL ON "TariffUrdbSource" TO service_role;
