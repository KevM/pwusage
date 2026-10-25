-- Day record v2 (docs/plans/2026-10-24-day-record-v2.md, "Empty days"): a durable
-- "Tesla answered this day with no samples" marker, so a backfill can tell a day
-- it checked from one it never fetched. Additive and idempotent. Written only by
-- CompactHistoryStore.writeDay for a day with no record and no raw rows; a later
-- non-empty write deletes it. A fetch failure never writes one.
CREATE TABLE IF NOT EXISTS "EnergyDayEmpty" (
    site_id text NOT NULL REFERENCES "Site"(id) ON DELETE CASCADE,
    day_start timestamptz NOT NULL,
    day_end timestamptz NOT NULL,
    -- When the empty Tesla request was made (as EnergyDayArchive.fetched_at).
    checked_at timestamptz NOT NULL,
    PRIMARY KEY (site_id,day_start),
    CHECK (day_end > day_start AND day_end <= day_start + interval '27 hours')
);
ALTER TABLE "EnergyDayEmpty" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "EnergyDayEmpty" FROM PUBLIC, anon, authenticated;
GRANT ALL ON "EnergyDayEmpty" TO service_role;

-- Markers are keyed by local day like archives, so a timezone change drops them
-- with the archives (re-checking an empty day costs one Tesla request).
CREATE OR REPLACE FUNCTION public.invalidate_compact_energy_timezone() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('compact-energy:' || OLD.id, 0));
    IF EXISTS (SELECT 1 FROM public."EnergyDayArchive" WHERE site_id=OLD.id AND (raw_pruned OR sample_count<>(
        SELECT count(*) FROM public."EnergyData" e WHERE e.site_id="EnergyDayArchive".site_id AND e.timestamp>="EnergyDayArchive".day_start AND e.timestamp<"EnergyDayArchive".day_end))) THEN
        RAISE EXCEPTION 'Rebuild pruned energy days for the new timezone first (scripts/rebuild-site-timezone.ts)';
    END IF;
    DELETE FROM public."EnergyDayArchive" WHERE site_id = OLD.id;
    DELETE FROM public."EnergyDayEmpty" WHERE site_id = OLD.id;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.invalidate_compact_energy_timezone() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.invalidate_compact_energy_timezone() TO service_role;
