-- Migration: site_solar_layout_location_source
-- Created at: 2026-10-30T15:00:00.000Z

-- Where a stored home location came from: 'estimated' (admin-seeded, usually a
-- ZIP centre) or 'device' (the phone's own location). Every location stored
-- before this column existed was admin-seeded, so those are backfilled as
-- 'estimated'. Additive and idempotent.
ALTER TABLE "SiteSolarLayout" ADD COLUMN IF NOT EXISTS location_source text;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = '"SiteSolarLayout"'::regclass
          AND conname = 'SiteSolarLayout_location_source_check'
    ) THEN
        ALTER TABLE "SiteSolarLayout" ADD CONSTRAINT "SiteSolarLayout_location_source_check"
            CHECK (location_source IN ('estimated', 'device'));
    END IF;
END $$;

UPDATE "SiteSolarLayout" SET location_source = 'estimated'
WHERE latitude IS NOT NULL AND location_source IS NULL;
