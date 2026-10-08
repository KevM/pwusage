-- Migration: compact_energy_trim_recovery
-- Created at: 2026-10-07T19:46:00.356Z

-- TODO: If this migration creates a new table, you MUST enable Row Level Security (RLS)!
-- ALTER TABLE "MyNewTable" ENABLE ROW LEVEL SECURITY;
-- REVOKE ALL ON "MyNewTable" FROM PUBLIC;
-- REVOKE ALL ON "MyNewTable" FROM anon;
-- REVOKE ALL ON "MyNewTable" FROM authenticated;
-- GRANT ALL ON "MyNewTable" TO service_role;
--
-- If using serial/sequence:
-- GRANT ALL ON SEQUENCE "MyNewTable_id_seq" TO service_role;

-- Existing archive RLS applies. No data is pruned by this migration.
ALTER TABLE "EnergyDayArchive" ADD COLUMN raw_pruned boolean NOT NULL DEFAULT false;
CREATE OR REPLACE FUNCTION public.invalidate_compact_energy_day() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE first_site text; second_site text;
BEGIN
    IF TG_OP = 'INSERT' THEN
        first_site := NEW.site_id;
    ELSIF TG_OP = 'DELETE' THEN
        first_site := OLD.site_id;
    ELSE
        first_site := LEAST(OLD.site_id, NEW.site_id);
        second_site := GREATEST(OLD.site_id, NEW.site_id);
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('compact-energy:' || first_site, 0));
    IF second_site IS NOT NULL AND second_site <> first_site THEN
        PERFORM pg_advisory_xact_lock(hashtextextended('compact-energy:' || second_site, 0));
    END IF;
    -- Once raw samples are pruned, this day must be restored before corrections.
    -- Verified trimming marks the archive authoritative before deleting its raw rows.
    IF TG_OP = 'DELETE' AND EXISTS (
        SELECT 1 FROM public."EnergyDayArchive" WHERE site_id=OLD.site_id
        AND day_start<=OLD.timestamp AND day_end>OLD.timestamp AND raw_pruned
    ) THEN RETURN OLD; END IF;
    IF TG_OP <> 'INSERT' AND EXISTS (
        SELECT 1 FROM public."EnergyDayArchive" WHERE site_id=OLD.site_id
        AND day_start<=OLD.timestamp AND day_end>OLD.timestamp AND raw_pruned
    ) THEN RAISE EXCEPTION 'Restore pruned energy day before mutation'; END IF;
    IF TG_OP <> 'DELETE' AND EXISTS (
        SELECT 1 FROM public."EnergyDayArchive" WHERE site_id=NEW.site_id
        AND day_start<=NEW.timestamp AND day_end>NEW.timestamp AND raw_pruned
    ) THEN RAISE EXCEPTION 'Restore pruned energy day before mutation'; END IF;
    -- A damaged state marker must not turn an archive-only day into a partial raw day.
    IF TG_OP <> 'INSERT' AND EXISTS (
        SELECT 1 FROM public."EnergyDayArchive" a WHERE a.site_id=OLD.site_id
        AND a.day_start<=OLD.timestamp AND a.day_end>OLD.timestamp AND NOT a.raw_pruned
        AND a.sample_count<>(SELECT count(*) FROM public."EnergyData" e WHERE e.site_id=a.site_id AND e.timestamp>=a.day_start AND e.timestamp<a.day_end)
    ) THEN RAISE EXCEPTION 'Raw archive source incomplete; restore before mutation'; END IF;
    IF TG_OP <> 'DELETE' AND EXISTS (
        SELECT 1 FROM public."EnergyDayArchive" a WHERE a.site_id=NEW.site_id
        AND a.day_start<=NEW.timestamp AND a.day_end>NEW.timestamp AND NOT a.raw_pruned
        AND a.sample_count<>(SELECT count(*) FROM public."EnergyData" e WHERE e.site_id=a.site_id AND e.timestamp>=a.day_start AND e.timestamp<a.day_end)
    ) THEN RAISE EXCEPTION 'Raw archive source incomplete; restore before mutation'; END IF;
    IF TG_OP <> 'INSERT' THEN
        DELETE FROM public."EnergyDayArchive"
        WHERE site_id = OLD.site_id AND day_start <= OLD.timestamp AND day_end > OLD.timestamp;
    END IF;
    IF TG_OP <> 'DELETE' THEN
        DELETE FROM public."EnergyDayArchive"
        WHERE site_id = NEW.site_id AND day_start <= NEW.timestamp AND day_end > NEW.timestamp;
        RETURN NEW;
    END IF;
    RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION public.invalidate_compact_energy_day() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.invalidate_compact_energy_day() TO service_role;
CREATE OR REPLACE FUNCTION public.invalidate_compact_energy_timezone() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('compact-energy:' || OLD.id, 0));
    IF EXISTS (SELECT 1 FROM public."EnergyDayArchive" WHERE site_id=OLD.id AND (raw_pruned OR sample_count<>(
        SELECT count(*) FROM public."EnergyData" e WHERE e.site_id="EnergyDayArchive".site_id AND e.timestamp>="EnergyDayArchive".day_start AND e.timestamp<"EnergyDayArchive".day_end))) THEN
        RAISE EXCEPTION 'Restore pruned energy days before timezone change';
    END IF;
    DELETE FROM public."EnergyDayArchive" WHERE site_id = OLD.id;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.invalidate_compact_energy_timezone() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.invalidate_compact_energy_timezone() TO service_role;

-- Bounded, service-only parity proof avoids sending raw samples back to maintenance.
CREATE OR REPLACE FUNCTION public.compact_raw_day_digest(p_site text,p_start timestamptz,p_end timestamptz)
RETURNS TABLE(digest text,samples integer)
LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE body bytea; n integer; fractional boolean;
BEGIN
    IF p_site IS NULL OR octet_length(p_site)>800 OR p_start IS NULL OR p_end IS NULL
        OR NOT isfinite(p_start) OR NOT isfinite(p_end) OR p_end<=p_start OR p_end-p_start>interval '27 hours'
        OR p_start<>date_trunc('milliseconds',p_start) OR p_end<>date_trunc('milliseconds',p_end) THEN
        RAISE EXCEPTION 'Invalid raw digest bounds';
    END IF;
    SELECT count(*)::integer,bool_or(timestamp<>date_trunc('milliseconds',timestamp)),
        string_agg(int8send((extract(epoch FROM timestamp)*1000)::bigint)||int4send(tariff_id)
            ||CASE WHEN tariff_schedule_id IS NULL THEN decode('00','hex') ELSE decode('01','hex') END
            ||int4send(coalesce(tariff_schedule_id,0))
            ||float8send(load_power::float8)||float8send(solar_power::float8)||float8send(grid_power::float8)||float8send(battery_power::float8)
            ||CASE WHEN battery_soc IS NULL THEN decode('00','hex') ELSE decode('01','hex') END
            ||float8send(coalesce(battery_soc,0)::float8),''::bytea ORDER BY timestamp)
    INTO n,fractional,body FROM (
        SELECT timestamp,tariff_id,tariff_schedule_id,load_power,solar_power,grid_power,battery_power,battery_soc
        FROM public."EnergyData" WHERE site_id=p_site AND timestamp>=p_start AND timestamp<p_end ORDER BY timestamp LIMIT 4097
    ) bounded;
    IF n>4096 OR fractional THEN RAISE EXCEPTION 'Unsupported raw digest source'; END IF;
    RETURN QUERY SELECT encode(sha256(convert_to('CERS1','UTF8')||int4send(octet_length(p_site))||convert_to(p_site,'UTF8')
        ||int8send((extract(epoch FROM p_start)*1000)::bigint)||int8send((extract(epoch FROM p_end)*1000)::bigint)
        ||int4send(n)||coalesce(body,''::bytea)),'hex'),n;
END;
$$;
REVOKE ALL ON FUNCTION public.compact_raw_day_digest(text,timestamptz,timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.compact_raw_day_digest(text,timestamptz,timestamptz) TO service_role;
