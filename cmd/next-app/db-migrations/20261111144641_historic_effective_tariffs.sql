-- Migration: historic_effective_tariffs
-- Created at: 2026-11-11T20:46:41.373Z

-- TODO: If this migration creates a new table, you MUST enable Row Level Security (RLS)!
-- ALTER TABLE "MyNewTable" ENABLE ROW LEVEL SECURITY;
-- REVOKE ALL ON "MyNewTable" FROM PUBLIC;
-- REVOKE ALL ON "MyNewTable" FROM anon;
-- REVOKE ALL ON "MyNewTable" FROM authenticated;
-- GRANT ALL ON "MyNewTable" TO service_role;
--
-- If using serial/sequence:
-- GRANT ALL ON SEQUENCE "MyNewTable_id_seq" TO service_role;


CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "Tariff"
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'tesla',
  ADD COLUMN IF NOT EXISTS created_by_user_id TEXT REFERENCES "User"(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tariff_source_check') THEN
    ALTER TABLE "Tariff"
      ADD CONSTRAINT tariff_source_check CHECK (source IN ('tesla', 'manual'));
  END IF;
END $$;

-- Deduplicate any pre-existing sites with multiple is_current rows across different names before tightening the index.
WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY site_id ORDER BY id DESC) AS rn
  FROM "Tariff"
  WHERE is_current = TRUE
)
UPDATE "Tariff" t
SET is_current = FALSE
FROM ranked r
WHERE t.id = r.id AND r.rn > 1;

DROP INDEX IF EXISTS tariff_current_uidx;
CREATE UNIQUE INDEX tariff_current_uidx ON "Tariff" (site_id) WHERE is_current;

CREATE TABLE IF NOT EXISTS "TariffEffectivePeriod" (
  id                 SERIAL PRIMARY KEY,
  site_id            TEXT NOT NULL REFERENCES "Site"(id) ON DELETE CASCADE,
  tariff_id          INTEGER NOT NULL REFERENCES "Tariff"(id) ON DELETE CASCADE,
  effective_from     DATE NOT NULL,
  effective_to       DATE,
  source             TEXT NOT NULL CHECK (source IN ('tesla', 'manual')),
  updated_by_user_id TEXT REFERENCES "User"(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE INDEX IF NOT EXISTS tariff_effective_period_site_dates_idx
  ON "TariffEffectivePeriod" (site_id, effective_from, effective_to);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tariff_effective_period_no_overlap') THEN
    ALTER TABLE "TariffEffectivePeriod"
      ADD CONSTRAINT tariff_effective_period_no_overlap
      EXCLUDE USING gist (
        site_id WITH =,
        daterange(effective_from, COALESCE((effective_to + INTERVAL '1 day')::date, 'infinity'::date), '[)') WITH &&
      );
  END IF;
END $$;

ALTER TABLE "TariffEffectivePeriod" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "TariffEffectivePeriod" FROM PUBLIC, anon, authenticated;
GRANT ALL ON "TariffEffectivePeriod" TO service_role;
GRANT ALL ON SEQUENCE "TariffEffectivePeriod_id_seq" TO service_role;

CREATE TABLE IF NOT EXISTS "SiteTariffReattribution" (
  site_id              TEXT PRIMARY KEY REFERENCES "Site"(id) ON DELETE CASCADE,
  status               TEXT NOT NULL CHECK (status IN ('pending', 'running', 'idle', 'failed')),
  generation           INTEGER NOT NULL DEFAULT 1,
  from_date            DATE NOT NULL,
  to_date              DATE,
  cursor_day_start     TIMESTAMPTZ,
  total_days           INTEGER NOT NULL DEFAULT 0,
  processed_days       INTEGER NOT NULL DEFAULT 0,
  updated_days         INTEGER NOT NULL DEFAULT 0,
  attempt_count        INTEGER NOT NULL DEFAULT 0,
  last_error           TEXT,
  requested_by_user_id TEXT REFERENCES "User"(id) ON DELETE SET NULL,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE "SiteTariffReattribution" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "SiteTariffReattribution" FROM PUBLIC, anon, authenticated;
GRANT ALL ON "SiteTariffReattribution" TO service_role;

-- Backfill one open-ended 'tesla' effective period for sites with a current tariff and none yet recorded.
INSERT INTO "TariffEffectivePeriod" (site_id, tariff_id, effective_from, effective_to, source, updated_by_user_id)
SELECT
  t.site_id,
  t.id,
  COALESCE(
    (
      SELECT (MIN(a.day_start) AT TIME ZONE COALESCE(s.timezone, 'UTC'))::date
      FROM "EnergyDayArchive" a
      WHERE a.site_id = s.id
    ),
    (now() AT TIME ZONE COALESCE(s.timezone, 'UTC'))::date
  ),
  NULL,
  'tesla',
  NULL
FROM "Tariff" t
JOIN "Site" s ON s.id = t.site_id
WHERE t.is_current = TRUE
  AND NOT EXISTS (
    SELECT 1 FROM "TariffEffectivePeriod" p WHERE p.site_id = t.site_id
  );
