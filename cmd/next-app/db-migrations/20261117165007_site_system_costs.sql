-- Migration: site_system_costs
-- Created at: 2026-11-16T21:59:11.000Z

CREATE TABLE IF NOT EXISTS "SiteSystemCost" (
  site_id            TEXT NOT NULL REFERENCES "Site"(id) ON DELETE CASCADE,
  component          TEXT NOT NULL CHECK (component IN ('solar', 'powerwall')),
  install_date       DATE,
  price              NUMERIC(12,2) NOT NULL CHECK (price >= 0),
  tax_credit_percent NUMERIC(5,2) CHECK (tax_credit_percent BETWEEN 0 AND 100),
  incentives         NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (incentives >= 0),
  updated_by_user_id TEXT REFERENCES "User"(id) ON DELETE SET NULL,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (site_id, component)
);

ALTER TABLE "SiteSystemCost" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "SiteSystemCost" FROM PUBLIC, anon, authenticated;
GRANT ALL ON "SiteSystemCost" TO service_role;
