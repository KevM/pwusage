-- Migration: drop_legacy_day_record_state
-- Created at: 2026-10-27T18:07:37.151Z

-- Deploy refactor/v2-history-readers first. Older writers name raw_pruned in
-- their INSERTs and cannot run after this migration. No sample payloads or
-- summaries are rewritten. Historical backups use their matching code checkout.
-- No new tables or access grants: existing RLS and service-only access remain.

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM "EnergyDayArchive" WHERE format_version IS DISTINCT FROM 2 OR metadata_version IS DISTINCT FROM 3) THEN
        RAISE EXCEPTION 'Legacy energy day records remain; convert them before removing legacy state';
    END IF;
END $$;

ALTER TABLE "EnergyDayArchive"
    DROP CONSTRAINT IF EXISTS "EnergyDayArchive_empty_record_check",
    DROP CONSTRAINT IF EXISTS "EnergyDayArchive_format_version_check",
    DROP CONSTRAINT IF EXISTS "EnergyDayArchive_metadata_version_check",
    DROP CONSTRAINT IF EXISTS "EnergyDayArchive_v2_record_check";
ALTER TABLE "EnergyDayArchive" DROP COLUMN IF EXISTS raw_pruned;
ALTER TABLE "EnergyDayArchive"
    ALTER COLUMN format_version SET DEFAULT 2,
    ALTER COLUMN metadata_version SET DEFAULT 3,
    ADD CONSTRAINT "EnergyDayArchive_format_version_check" CHECK (format_version = 2),
    ADD CONSTRAINT "EnergyDayArchive_metadata_version_check" CHECK (metadata_version = 3),
    ADD CONSTRAINT "EnergyDayArchive_v2_record_check" CHECK (
        metadata_version = 3 AND status IS NOT NULL AND fetched_at IS NOT NULL
        AND (metadata_checksum IS NOT NULL OR status = 'empty')
    ),
    ADD CONSTRAINT "EnergyDayArchive_empty_record_check" CHECK (
        CASE WHEN status IS NOT DISTINCT FROM 'empty' THEN
            format_version = 2 AND metadata_version = 3 AND sample_count = 0
            AND expected_slots = ceil(EXTRACT(EPOCH FROM (day_end - day_start)) / 300)::integer
            AND payload IS NULL AND checksum IS NULL AND codec IS NULL AND axis IS NULL AND payload_checksum IS NULL
            AND metadata_checksum IS NULL AND first_timestamp IS NULL AND last_timestamp IS NULL AND max_interior_gap_ms IS NULL
            AND latest_metadata IS NULL AND latest_checksum IS NULL AND attribution IS NULL
            AND NOT attribution_complete AND fetched_at IS NOT NULL
        ELSE sample_count >= 1 AND payload IS NOT NULL AND checksum IS NOT NULL AND codec IS NOT NULL AND axis IS NOT NULL
        END
    );

-- CEM3 remains byte-for-byte identical to compact-day-metadata.ts. CEM2 is no
-- longer a supported day-metadata digest. CEL1 latest projections are independent
-- of the retired payload format and remain unchanged.
CREATE OR REPLACE FUNCTION public.verify_compact_day_metadata(p_site text,p_day timestamptz,p_billing boolean)
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=public,pg_temp AS $$
DECLARE a record; body bytea; row_count bigint; sample_sum bigint; actual text; attribution_bytes bytea:=''::bytea;
    timeline bytea; segment_count bigint; segment_body bytea;
BEGIN
    SELECT site_id,day_start,day_end,revision,attribution_complete,sample_count,first_timestamp,last_timestamp,
        max_interior_gap_ms,metadata_checksum,format_version,metadata_version,attribution INTO a
    FROM public."EnergyDayArchive" WHERE site_id=p_site AND day_start=p_day;
    IF NOT FOUND OR a.format_version<>2 OR a.metadata_version<>3 OR a.metadata_checksum IS NULL THEN
        RAISE EXCEPTION 'Day metadata mismatch';
    END IF;
    IF jsonb_typeof(a.attribution->'timelineRevision') IS DISTINCT FROM 'string' OR jsonb_typeof(a.attribution->'segments') IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'Day metadata mismatch';
    END IF;
    timeline:=convert_to(a.attribution->>'timelineRevision','UTF8');
    SELECT count(*),string_agg(int4send((s->>'offset')::integer) || int4send((s->>'tariffId')::integer)
        || decode(CASE WHEN s->>'scheduleId' IS NULL THEN '00' ELSE '01' END,'hex') || int4send(COALESCE((s->>'scheduleId')::integer,0)),
        ''::bytea ORDER BY n)
        INTO segment_count,segment_body
    FROM jsonb_array_elements(a.attribution->'segments') WITH ORDINALITY AS e(s,n);
    IF segment_count<1 THEN RAISE EXCEPTION 'Day metadata mismatch'; END IF;
    attribution_bytes:=int4send(octet_length(timeline)) || timeline || int4send(segment_count::integer) || segment_body;
    SELECT count(*),sum(sample_count),string_agg(
        int4send(tariff_id) || decode(CASE WHEN tariff_schedule_id IS NULL THEN '00' ELSE '01' END,'hex') || int4send(COALESCE(tariff_schedule_id,0))
        || float8send(load_power) || float8send(solar_power) || float8send(grid_power) || float8send(battery_power)
        || float8send(sample_import_wh) || float8send(sample_export_wh) || float8send(sample_charge_wh) || float8send(sample_discharge_wh)
        || int4send(sample_count),''::bytea ORDER BY tariff_id,tariff_schedule_id NULLS FIRST)
        INTO row_count,sample_sum,body
    FROM public."EnergyDaySummary" WHERE site_id=p_site AND day_start=p_day AND revision=a.revision;
    IF row_count<1 OR sample_sum<>a.sample_count THEN RAISE EXCEPTION 'Day metadata mismatch'; END IF;
    actual:=encode(sha256(decode('43454d33','hex') || int4send(octet_length(convert_to(a.site_id,'UTF8'))) || convert_to(a.site_id,'UTF8')
        || int8send((EXTRACT(EPOCH FROM a.day_start)*1000)::bigint) || int8send((EXTRACT(EPOCH FROM a.day_end)*1000)::bigint)
        || decode(CASE WHEN a.attribution_complete THEN '01' ELSE '00' END,'hex') || int4send(a.sample_count)
        || int8send((EXTRACT(EPOCH FROM a.first_timestamp)*1000)::bigint) || int8send((EXTRACT(EPOCH FROM a.last_timestamp)*1000)::bigint)
        || int4send(a.max_interior_gap_ms) || attribution_bytes || int4send(row_count::integer) || body),'hex');
    IF actual IS DISTINCT FROM a.metadata_checksum THEN RAISE EXCEPTION 'Day metadata mismatch'; END IF;
    IF p_billing AND (NOT a.attribution_complete OR EXISTS (
        SELECT 1 FROM public."EnergyDaySummary" WHERE site_id=p_site AND day_start=p_day AND revision=a.revision AND tariff_schedule_id IS NULL
    )) THEN RAISE EXCEPTION 'Incomplete tariff attribution'; END IF;
    RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.verify_compact_day_metadata(text,timestamptz,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.verify_compact_day_metadata(text,timestamptz,boolean) TO service_role;
