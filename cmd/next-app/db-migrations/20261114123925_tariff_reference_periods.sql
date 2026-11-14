-- Migration: tariff_reference_periods
-- Created at: 2026-11-14T18:39:25.154Z

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS "TariffReferencePeriod" (
  id                 SERIAL PRIMARY KEY,
  site_id            TEXT NOT NULL REFERENCES "Site"(id) ON DELETE CASCADE,
  tariff_id          INTEGER NOT NULL REFERENCES "Tariff"(id) ON DELETE CASCADE,
  effective_from     DATE NOT NULL,
  effective_to       DATE,
  updated_by_user_id TEXT REFERENCES "User"(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE INDEX IF NOT EXISTS tariff_reference_period_site_dates_idx
  ON "TariffReferencePeriod" (site_id, effective_from, effective_to);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tariff_reference_period_no_overlap') THEN
    ALTER TABLE "TariffReferencePeriod"
      ADD CONSTRAINT tariff_reference_period_no_overlap
      EXCLUDE USING gist (
        site_id WITH =,
        daterange(effective_from, COALESCE((effective_to + INTERVAL '1 day')::date, 'infinity'::date), '[)') WITH &&
      );
  END IF;
END $$;

ALTER TABLE "TariffReferencePeriod" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "TariffReferencePeriod" FROM PUBLIC, anon, authenticated;
GRANT ALL ON "TariffReferencePeriod" TO service_role;
GRANT ALL ON SEQUENCE "TariffReferencePeriod_id_seq" TO service_role;
