-- Migration: compact_day_range_verification
-- Created at: 2026-11-22T16:20:56.912Z
-- No new table: one function, service_role only.

-- Verifies every settled-format day record wholly inside [p_start, p_end) in one
-- query. It checks exactly what verify_compact_day_metadata(site, day, false) checks
-- for each day (attribution shape, at least one segment and one summary row, the
-- summaries' sample count, and the CEM3 digest byte-for-byte), and raises the same
-- 'Day metadata mismatch' on the first failing day. Calling the per-day function once
-- per day cost a plpgsql call and three queries per day (35 ms for a 365-day read on
-- Dev, against 7 ms here). Billing attribution is not checked here: callers that
-- bill check it separately, and coverage-only reads skip it.
CREATE OR REPLACE FUNCTION public.verify_compact_day_range(p_site text,p_start timestamptz,p_end timestamptz)
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=public,pg_temp AS $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM public."EnergyDayArchive" a
        CROSS JOIN LATERAL (
            -- Never expand a non-array: that day fails the shape check below instead.
            SELECT count(*) AS n,string_agg(int4send((s->>'offset')::integer) || int4send((s->>'tariffId')::integer)
                || decode(CASE WHEN s->>'scheduleId' IS NULL THEN '00' ELSE '01' END,'hex') || int4send(COALESCE((s->>'scheduleId')::integer,0)),
                ''::bytea ORDER BY e.n) AS body
            FROM jsonb_array_elements(CASE WHEN jsonb_typeof(a.attribution->'segments')='array' THEN a.attribution->'segments' ELSE '[]'::jsonb END)
                WITH ORDINALITY AS e(s,n)
        ) g
        CROSS JOIN LATERAL (
            SELECT count(*) AS n,sum(s.sample_count) AS samples,string_agg(
                int4send(s.tariff_id) || decode(CASE WHEN s.tariff_schedule_id IS NULL THEN '00' ELSE '01' END,'hex') || int4send(COALESCE(s.tariff_schedule_id,0))
                || float8send(s.load_power) || float8send(s.solar_power) || float8send(s.grid_power) || float8send(s.battery_power)
                || float8send(s.sample_import_wh) || float8send(s.sample_export_wh) || float8send(s.sample_charge_wh) || float8send(s.sample_discharge_wh)
                || int4send(s.sample_count),''::bytea ORDER BY s.tariff_id,s.tariff_schedule_id NULLS FIRST) AS body
            FROM public."EnergyDaySummary" s WHERE s.site_id=a.site_id AND s.day_start=a.day_start AND s.revision=a.revision
        ) m
        WHERE a.site_id=p_site AND a.day_start>=p_start AND a.day_end<=p_end
            AND a.format_version=2 AND a.metadata_version=3 AND a.metadata_checksum IS NOT NULL
            -- IS NOT TRUE: a NULL anywhere (a missing field or segment) fails the day.
            AND (jsonb_typeof(a.attribution->'timelineRevision')='string' AND g.n>=1 AND m.n>=1 AND m.samples=a.sample_count
                AND encode(sha256(decode('43454d33','hex') || int4send(octet_length(convert_to(a.site_id,'UTF8'))) || convert_to(a.site_id,'UTF8')
                    || int8send((EXTRACT(EPOCH FROM a.day_start)*1000)::bigint) || int8send((EXTRACT(EPOCH FROM a.day_end)*1000)::bigint)
                    || decode(CASE WHEN a.attribution_complete THEN '01' ELSE '00' END,'hex') || int4send(a.sample_count)
                    || int8send((EXTRACT(EPOCH FROM a.first_timestamp)*1000)::bigint) || int8send((EXTRACT(EPOCH FROM a.last_timestamp)*1000)::bigint)
                    || int4send(a.max_interior_gap_ms)
                    || int4send(octet_length(convert_to(a.attribution->>'timelineRevision','UTF8'))) || convert_to(a.attribution->>'timelineRevision','UTF8')
                    || int4send(g.n::integer) || g.body
                    || int4send(m.n::integer) || m.body),'hex')=a.metadata_checksum) IS NOT TRUE
    ) THEN RAISE EXCEPTION 'Day metadata mismatch'; END IF;
    RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.verify_compact_day_range(text,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.verify_compact_day_range(text,timestamptz,timestamptz) TO service_role;
