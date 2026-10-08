-- Canonical binary metadata format 2 permits verification inside PostgreSQL.
-- Existing JSON-format digests remain version 1 and keep the detailed path.
ALTER TABLE "EnergyDayArchive" ADD COLUMN metadata_version smallint NOT NULL DEFAULT 1 CHECK (metadata_version IN (1,2));

CREATE FUNCTION public.verify_compact_day_metadata(p_site text,p_day timestamptz,p_billing boolean)
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=public,pg_temp AS $$
DECLARE a record; body bytea; row_count bigint; sample_sum bigint; actual text;
BEGIN
    SELECT site_id,day_start,day_end,revision,attribution_complete,sample_count,first_timestamp,last_timestamp,
        max_interior_gap_ms,metadata_checksum,metadata_version INTO a
    FROM public."EnergyDayArchive" WHERE site_id=p_site AND day_start=p_day;
    IF NOT FOUND OR a.metadata_version<>2 OR a.metadata_checksum IS NULL THEN
        RAISE EXCEPTION 'Day metadata mismatch';
    END IF;
    SELECT count(*),sum(sample_count),string_agg(
        int4send(tariff_id) || decode(CASE WHEN tariff_schedule_id IS NULL THEN '00' ELSE '01' END,'hex') || int4send(COALESCE(tariff_schedule_id,0))
        || float8send(load_power) || float8send(solar_power) || float8send(grid_power) || float8send(battery_power)
        || float8send(sample_import_wh) || float8send(sample_export_wh) || float8send(sample_charge_wh) || float8send(sample_discharge_wh)
        || int4send(sample_count),''::bytea ORDER BY tariff_id,tariff_schedule_id NULLS FIRST)
        INTO row_count,sample_sum,body
    FROM public."EnergyDaySummary" WHERE site_id=p_site AND day_start=p_day AND revision=a.revision;
    IF row_count<1 OR sample_sum<>a.sample_count THEN RAISE EXCEPTION 'Day metadata mismatch'; END IF;
    actual:=encode(sha256(decode('43454d32','hex') || int4send(octet_length(convert_to(a.site_id,'UTF8'))) || convert_to(a.site_id,'UTF8')
        || int8send((EXTRACT(EPOCH FROM a.day_start)*1000)::bigint) || int8send((EXTRACT(EPOCH FROM a.day_end)*1000)::bigint)
        || decode(CASE WHEN a.attribution_complete THEN '01' ELSE '00' END,'hex') || int4send(a.sample_count)
        || int8send((EXTRACT(EPOCH FROM a.first_timestamp)*1000)::bigint) || int8send((EXTRACT(EPOCH FROM a.last_timestamp)*1000)::bigint)
        || int4send(a.max_interior_gap_ms) || int4send(row_count::integer) || body),'hex');
    IF actual IS DISTINCT FROM a.metadata_checksum THEN RAISE EXCEPTION 'Day metadata mismatch'; END IF;
    IF p_billing AND (NOT a.attribution_complete OR EXISTS (
        SELECT 1 FROM public."EnergyDaySummary" WHERE site_id=p_site AND day_start=p_day AND revision=a.revision AND tariff_schedule_id IS NULL
    )) THEN RAISE EXCEPTION 'Incomplete tariff attribution'; END IF;
    RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.verify_compact_day_metadata(text,timestamptz,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.verify_compact_day_metadata(text,timestamptz,boolean) TO service_role;
