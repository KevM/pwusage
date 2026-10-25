-- Migration: day_record_empty_status
-- Created at: 2026-10-25T18:10:43.783Z

-- Day record v2 (docs/plans/2026-10-24-day-record-v2.md, "Empty days"): a day Tesla
-- answered with no samples is an `empty` day record in "EnergyDayArchive" instead of
-- a row in the separate "EnergyDayEmpty" marker table, so each (site, day) has one
-- source of truth, like `gapped`. Idempotent; safe where "EnergyDayEmpty" never existed.
--
-- An empty record is exactly: status 'empty', format 2 / metadata 3, sample_count 0,
-- expected_slots from the day length, fetched_at (the request time), and nothing
-- else: no payload, checksums, codec, axis, first/last timestamps, gap, latest
-- projection, attribution or summary rows; attribution_complete and raw_pruned false.
-- It has no metadata digest, so verify_compact_day_metadata (which raises on a NULL
-- metadata_checksum) and verify_compact_latest_metadata (on a NULL projection) are
-- never called for it: readers skip `status = 'empty'` rows. A raw insert into the day
-- drops it (invalidate_compact_energy_day deletes the day's archive; 0 = 0 raw rows
-- passes its count guard), and a timezone change drops it with the other archives.

ALTER TABLE "EnergyDayArchive"
    ALTER COLUMN codec DROP NOT NULL,
    ALTER COLUMN axis DROP NOT NULL,
    ALTER COLUMN checksum DROP NOT NULL,
    ALTER COLUMN payload DROP NOT NULL;

ALTER TABLE "EnergyDayArchive"
    DROP CONSTRAINT IF EXISTS "EnergyDayArchive_sample_count_check",
    DROP CONSTRAINT IF EXISTS "EnergyDayArchive_status_check",
    DROP CONSTRAINT IF EXISTS "EnergyDayArchive_attribution_check",
    DROP CONSTRAINT IF EXISTS "EnergyDayArchive_v2_record_check",
    DROP CONSTRAINT IF EXISTS "EnergyDayArchive_empty_record_check";
ALTER TABLE "EnergyDayArchive"
    ADD CONSTRAINT "EnergyDayArchive_sample_count_check" CHECK (sample_count BETWEEN 0 AND 4096),
    ADD CONSTRAINT "EnergyDayArchive_status_check" CHECK (
        status IS NULL OR (status IN ('open','complete','gapped','empty') AND (status <> 'complete' OR sample_count = expected_slots))
    ),
    ADD CONSTRAINT "EnergyDayArchive_attribution_check" CHECK (
        (metadata_version = 3 AND status IS DISTINCT FROM 'empty') = (attribution IS NOT NULL)
        AND (attribution IS NULL OR (jsonb_typeof(attribution->'timelineRevision') IS NOT DISTINCT FROM 'string' AND jsonb_typeof(attribution->'segments') IS NOT DISTINCT FROM 'array'))
    ),
    -- A v2 record carries its attribution, status, fetch time and a verifiable v3 digest; an empty one has no digest.
    ADD CONSTRAINT "EnergyDayArchive_v2_record_check" CHECK (
        format_version = 1 OR (metadata_version = 3 AND status IS NOT NULL AND fetched_at IS NOT NULL
            AND (metadata_checksum IS NOT NULL OR status = 'empty'))
    ),
    -- The empty shape is exact, and every other row keeps its samples and payload.
    ADD CONSTRAINT "EnergyDayArchive_empty_record_check" CHECK (
        CASE WHEN status IS NOT DISTINCT FROM 'empty' THEN
            format_version = 2 AND metadata_version = 3 AND sample_count = 0
            AND expected_slots = ceil(EXTRACT(EPOCH FROM (day_end - day_start)) / 300)::integer
            AND payload IS NULL AND checksum IS NULL AND codec IS NULL AND axis IS NULL AND payload_checksum IS NULL
            AND metadata_checksum IS NULL AND first_timestamp IS NULL AND last_timestamp IS NULL AND max_interior_gap_ms IS NULL
            AND latest_metadata IS NULL AND latest_checksum IS NULL AND attribution IS NULL
            AND NOT attribution_complete AND NOT raw_pruned AND fetched_at IS NOT NULL
        ELSE sample_count >= 1 AND payload IS NOT NULL AND checksum IS NOT NULL AND codec IS NOT NULL AND axis IS NOT NULL
        END
    );

-- An empty record has no summary rows.
CREATE OR REPLACE FUNCTION public.refuse_empty_day_summary() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM public."EnergyDayArchive" WHERE site_id=NEW.site_id AND day_start=NEW.day_start AND status='empty') THEN
        RAISE EXCEPTION 'An empty day record has no summaries';
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.refuse_empty_day_summary() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refuse_empty_day_summary() TO service_role;
DROP TRIGGER IF EXISTS refuse_empty_day_summary ON "EnergyDaySummary";
CREATE TRIGGER refuse_empty_day_summary BEFORE INSERT OR UPDATE ON "EnergyDaySummary"
FOR EACH ROW EXECUTE FUNCTION public.refuse_empty_day_summary();

-- Markers become empty records: only for days with nothing else stored (no record, no
-- raw rows), as CompactHistoryStore.writeDay would have written them. checked_at is
-- the request time, i.e. fetched_at.
DO $$
BEGIN
    IF to_regclass('public."EnergyDayEmpty"') IS NOT NULL THEN
        EXECUTE $sql$
            INSERT INTO public."EnergyDayArchive" (site_id,day_start,day_end,revision,format_version,codec,axis,checksum,payload,
                sample_count,expected_slots,attribution_complete,metadata_version,raw_pruned,status,fetched_at)
            SELECT e.site_id,e.day_start,e.day_end,gen_random_uuid(),2,NULL,NULL,NULL,NULL,
                0,ceil(EXTRACT(EPOCH FROM (e.day_end - e.day_start)) / 300)::integer,false,3,false,'empty',e.checked_at
            FROM public."EnergyDayEmpty" e
            WHERE NOT EXISTS (SELECT 1 FROM public."EnergyDayArchive" a WHERE a.site_id=e.site_id AND a.day_start<e.day_end AND a.day_end>e.day_start)
              AND NOT EXISTS (SELECT 1 FROM public."EnergyData" r WHERE r.site_id=e.site_id AND r.timestamp>=e.day_start AND r.timestamp<e.day_end)
        $sql$;
    END IF;
END
$$;

-- Redefined without the marker table (otherwise as in 20261025120000): empty records
-- are archives, so the archive delete drops them.
CREATE OR REPLACE FUNCTION public.invalidate_compact_energy_timezone() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('compact-energy:' || OLD.id, 0));
    IF EXISTS (SELECT 1 FROM public."EnergyDayArchive" WHERE site_id=OLD.id AND (raw_pruned OR sample_count<>(
        SELECT count(*) FROM public."EnergyData" e WHERE e.site_id="EnergyDayArchive".site_id AND e.timestamp>="EnergyDayArchive".day_start AND e.timestamp<"EnergyDayArchive".day_end))) THEN
        RAISE EXCEPTION 'Rebuild pruned energy days for the new timezone first (scripts/rebuild-site-timezone.ts)';
    END IF;
    DELETE FROM public."EnergyDayArchive" WHERE site_id = OLD.id;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.invalidate_compact_energy_timezone() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.invalidate_compact_energy_timezone() TO service_role;

DROP TABLE IF EXISTS "EnergyDayEmpty";
