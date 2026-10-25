-- Day record v2, slice 1 (docs/plans/2026-10-24-day-record-v2.md): schema only.
-- Additive and idempotent. Existing v1 archives keep NULL attribution/status/fetched_at
-- until the v1 -> v2 conversion slice fills them; no rows or payloads are touched.
ALTER TABLE "EnergyDayArchive"
    ADD COLUMN IF NOT EXISTS attribution jsonb,
    ADD COLUMN IF NOT EXISTS status text,
    ADD COLUMN IF NOT EXISTS fetched_at timestamptz;

ALTER TABLE "EnergyDayArchive"
    DROP CONSTRAINT IF EXISTS "EnergyDayArchive_format_version_check",
    DROP CONSTRAINT IF EXISTS "EnergyDayArchive_metadata_version_check",
    DROP CONSTRAINT IF EXISTS "EnergyDayArchive_status_check",
    DROP CONSTRAINT IF EXISTS "EnergyDayArchive_attribution_check",
    DROP CONSTRAINT IF EXISTS "EnergyDayArchive_v2_record_check";
ALTER TABLE "EnergyDayArchive"
    -- Format 2 payloads hold samples only; metadata 3 adds the attribution to the digest.
    ADD CONSTRAINT "EnergyDayArchive_format_version_check" CHECK (format_version IN (1,2)),
    ADD CONSTRAINT "EnergyDayArchive_metadata_version_check" CHECK (metadata_version IN (1,2,3)),
    ADD CONSTRAINT "EnergyDayArchive_status_check" CHECK (
        status IS NULL OR (status IN ('open','complete','gapped') AND (status <> 'complete' OR sample_count = expected_slots))
    ),
    ADD CONSTRAINT "EnergyDayArchive_attribution_check" CHECK (
        (metadata_version = 3) = (attribution IS NOT NULL)
        AND (attribution IS NULL OR (jsonb_typeof(attribution->'timelineRevision') IS NOT DISTINCT FROM 'string' AND jsonb_typeof(attribution->'segments') IS NOT DISTINCT FROM 'array'))
    ),
    -- A v2 record carries its attribution, status, fetch time and a verifiable v3 digest.
    ADD CONSTRAINT "EnergyDayArchive_v2_record_check" CHECK (
        format_version = 1 OR (metadata_version = 3 AND metadata_checksum IS NOT NULL AND status IS NOT NULL AND fetched_at IS NOT NULL)
    );

-- Metadata 2 is unchanged. Metadata 3 inserts the attribution (revision, then each
-- segment's offset, tariff, schedule flag and schedule) before the summary rows,
-- mirroring compact-day-metadata.ts.
CREATE OR REPLACE FUNCTION public.verify_compact_day_metadata(p_site text,p_day timestamptz,p_billing boolean)
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=public,pg_temp AS $$
DECLARE a record; body bytea; row_count bigint; sample_sum bigint; actual text; magic text; attribution_bytes bytea:=''::bytea;
    timeline bytea; segment_count bigint; segment_body bytea;
BEGIN
    SELECT site_id,day_start,day_end,revision,attribution_complete,sample_count,first_timestamp,last_timestamp,
        max_interior_gap_ms,metadata_checksum,metadata_version,attribution INTO a
    FROM public."EnergyDayArchive" WHERE site_id=p_site AND day_start=p_day;
    IF NOT FOUND OR a.metadata_version NOT IN (2,3) OR a.metadata_checksum IS NULL THEN
        RAISE EXCEPTION 'Day metadata mismatch';
    END IF;
    magic:=CASE WHEN a.metadata_version=3 THEN '43454d33' ELSE '43454d32' END;
    IF a.metadata_version=3 THEN
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
    END IF;
    SELECT count(*),sum(sample_count),string_agg(
        int4send(tariff_id) || decode(CASE WHEN tariff_schedule_id IS NULL THEN '00' ELSE '01' END,'hex') || int4send(COALESCE(tariff_schedule_id,0))
        || float8send(load_power) || float8send(solar_power) || float8send(grid_power) || float8send(battery_power)
        || float8send(sample_import_wh) || float8send(sample_export_wh) || float8send(sample_charge_wh) || float8send(sample_discharge_wh)
        || int4send(sample_count),''::bytea ORDER BY tariff_id,tariff_schedule_id NULLS FIRST)
        INTO row_count,sample_sum,body
    FROM public."EnergyDaySummary" WHERE site_id=p_site AND day_start=p_day AND revision=a.revision;
    IF row_count<1 OR sample_sum<>a.sample_count THEN RAISE EXCEPTION 'Day metadata mismatch'; END IF;
    actual:=encode(sha256(decode(magic,'hex') || int4send(octet_length(convert_to(a.site_id,'UTF8'))) || convert_to(a.site_id,'UTF8')
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
