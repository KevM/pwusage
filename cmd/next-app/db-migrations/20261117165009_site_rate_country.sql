-- Migration: site_rate_country
-- Created at: 2026-11-17T22:40:24.114Z
-- Stores validated ISO-3166-1 alpha-2 country code and provenance per site so
-- URDB/OpenEI eligibility ('us' | 'outside_us' | 'unknown') is never inferred
-- from timezone, currency, phone location, or Tesla API region.
-- Existing sites start with NULL (unknown) until resolved by saved solar location
-- or owner confirmation.

ALTER TABLE "Site"
  ADD COLUMN IF NOT EXISTS rate_country TEXT,
  ADD COLUMN IF NOT EXISTS rate_country_source TEXT,
  ADD COLUMN IF NOT EXISTS rate_country_updated_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"Site"'::regclass AND conname = 'site_rate_country_code_check'
  ) THEN
    ALTER TABLE "Site" ADD CONSTRAINT site_rate_country_code_check
      CHECK (rate_country IS NULL OR rate_country ~ '^[A-Z]{2}$');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"Site"'::regclass AND conname = 'site_rate_country_source_check'
  ) THEN
    ALTER TABLE "Site" ADD CONSTRAINT site_rate_country_source_check
      CHECK (rate_country_source IS NULL OR rate_country_source IN ('solar_location', 'owner'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"Site"'::regclass AND conname = 'site_rate_country_pair_check'
  ) THEN
    ALTER TABLE "Site" ADD CONSTRAINT site_rate_country_pair_check
      CHECK (
        (rate_country IS NULL AND rate_country_source IS NULL)
        OR (rate_country IS NOT NULL AND rate_country_source IS NOT NULL)
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS site_rate_country_idx
  ON "Site" (rate_country)
  WHERE rate_country IS NOT NULL;
