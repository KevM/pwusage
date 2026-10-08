-- Migration: compact_energy_latest_projection
-- Created at: 2026-10-07T18:20:54.031Z

-- TODO: If this migration creates a new table, you MUST enable Row Level Security (RLS)!
-- ALTER TABLE "MyNewTable" ENABLE ROW LEVEL SECURITY;
-- REVOKE ALL ON "MyNewTable" FROM PUBLIC;
-- REVOKE ALL ON "MyNewTable" FROM anon;
-- REVOKE ALL ON "MyNewTable" FROM authenticated;
-- GRANT ALL ON "MyNewTable" TO service_role;
--
-- If using serial/sequence:
-- GRANT ALL ON SEQUENCE "MyNewTable_id_seq" TO service_role;

-- Same archive row/RLS/revision; no backfill and no raw deletion.
ALTER TABLE "EnergyDayArchive" ADD COLUMN latest_metadata jsonb, ADD COLUMN latest_checksum text,
    ADD CONSTRAINT "EnergyDayArchive_latest_metadata_pair" CHECK (
        (latest_metadata IS NULL AND latest_checksum IS NULL) OR
        (latest_metadata IS NOT NULL AND latest_checksum IS NOT NULL AND latest_metadata->>'version' IS NOT NULL AND latest_checksum ~ '^[0-9a-f]{64}$' AND latest_metadata->>'version'='1'));
CREATE INDEX "EnergyDayArchive_soc_timestamp_idx" ON "EnergyDayArchive" (site_id,((latest_metadata->'soc'->>'timestamp')::bigint) DESC)
    WHERE latest_metadata IS NOT NULL;

-- Verify every relevant projection before SOC selection, so tampering cannot hide it with a changed timestamp.
CREATE FUNCTION public.verify_compact_latest_metadata(p_site text,p_day timestamptz)
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=public,pg_temp AS $$
DECLARE a record; d jsonb; s jsonb; c jsonb; actual text;
BEGIN
    SELECT site_id,day_start,day_end,checksum,latest_metadata,latest_checksum INTO a FROM public."EnergyDayArchive" WHERE site_id=p_site AND day_start=p_day;
    IF NOT FOUND OR a.latest_metadata IS NULL OR a.latest_checksum IS NULL THEN RAISE EXCEPTION 'Latest metadata mismatch'; END IF;
    d:=a.latest_metadata;s:=d->'sample';c:=d->'soc';
    actual:=encode(sha256(decode('43454c31','hex')||int4send(octet_length(convert_to(a.site_id,'UTF8')))||convert_to(a.site_id,'UTF8')
        ||int8send((EXTRACT(EPOCH FROM a.day_start)*1000)::bigint)||int8send((EXTRACT(EPOCH FROM a.day_end)*1000)::bigint)||convert_to(a.checksum,'UTF8')||int4send((d->>'version')::int)
        ||int8send((s->>'timestamp')::bigint)||float8send((s->>'loadPower')::float8)||float8send((s->>'solarPower')::float8)||float8send((s->>'gridPower')::float8)||float8send((s->>'batteryPower')::float8)
        ||decode(CASE WHEN s->>'batterySoc' IS NULL THEN '00' ELSE '01' END,'hex')||float8send(COALESCE((s->>'batterySoc')::float8,0))
        ||decode(CASE WHEN c IS NULL OR c='null'::jsonb THEN '00' ELSE '01' END,'hex')||int8send(COALESCE((c->>'timestamp')::bigint,0))||float8send(COALESCE((c->>'value')::float8,0))),'hex');
    IF actual IS DISTINCT FROM a.latest_checksum THEN RAISE EXCEPTION 'Latest metadata mismatch'; END IF;
    RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.verify_compact_latest_metadata(text,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.verify_compact_latest_metadata(text,timestamptz) TO service_role;
