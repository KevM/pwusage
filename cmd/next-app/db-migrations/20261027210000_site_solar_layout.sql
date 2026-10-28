-- Migration: site_solar_layout
-- Created at: 2026-10-27T21:00:00.000Z

-- Automatic solar forecast (docs/superpowers/specs/2026-10-27-auto-solar-forecast-design.md).
-- One row per site: the home location the phone posted (rounded to 2 decimals,
-- about 1 km; a finer fix is never stored) and the latest panel layout detected
-- from the site's own production history. A failed run keeps the previous
-- result. Additive and idempotent.
CREATE TABLE IF NOT EXISTS "SiteSolarLayout" (
    site_id text PRIMARY KEY REFERENCES "Site"(id) ON DELETE CASCADE,
    latitude numeric(5,2),
    longitude numeric(6,2),
    location_set_at timestamptz,
    result jsonb,
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','detected','not-enough-history','low-confidence','failed')),
    detected_at timestamptz,
    attempted_at timestamptz,
    detector_version smallint,
    CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
    CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180)
);
ALTER TABLE "SiteSolarLayout" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "SiteSolarLayout" FROM PUBLIC, anon, authenticated;
GRANT ALL ON "SiteSolarLayout" TO service_role;
