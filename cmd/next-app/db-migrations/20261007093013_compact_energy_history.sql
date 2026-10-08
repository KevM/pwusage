-- Compact history remains opt-in. No backfill or raw deletion is performed.
CREATE TABLE "EnergyDayArchive" (
    site_id text NOT NULL REFERENCES "Site"(id) ON DELETE CASCADE,
    day_start timestamptz NOT NULL,
    day_end timestamptz NOT NULL,
    revision uuid NOT NULL,
    format_version smallint NOT NULL CHECK (format_version = 1),
    codec text NOT NULL CHECK (codec IN ('gzip','brotli')),
    axis text NOT NULL CHECK (axis IN ('grid','offsets')),
    checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
    payload bytea NOT NULL CHECK (octet_length(payload) BETWEEN 1 AND 1048576),
    sample_count integer NOT NULL CHECK (sample_count BETWEEN 1 AND 4096),
    expected_slots integer NOT NULL CHECK (expected_slots BETWEEN 1 AND 324),
    attribution_complete boolean NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (site_id,day_start),
    UNIQUE (site_id,day_start,revision),
    CHECK (day_end > day_start AND day_end <= day_start + interval '27 hours')
);
ALTER TABLE "EnergyDayArchive" ALTER COLUMN payload SET STORAGE EXTERNAL;

CREATE TABLE "EnergyDaySummary" (
    site_id text NOT NULL,
    day_start timestamptz NOT NULL,
    revision uuid NOT NULL,
    tariff_id integer NOT NULL REFERENCES "Tariff"(id),
    tariff_schedule_id integer REFERENCES "TariffSchedule"(id),
    load_power double precision NOT NULL,
    solar_power double precision NOT NULL,
    grid_power double precision NOT NULL,
    battery_power double precision NOT NULL,
    sample_import_wh double precision NOT NULL,
    sample_export_wh double precision NOT NULL,
    sample_charge_wh double precision NOT NULL,
    sample_discharge_wh double precision NOT NULL,
    sample_count integer NOT NULL CHECK (sample_count BETWEEN 1 AND 4096),
    FOREIGN KEY (site_id,day_start,revision) REFERENCES "EnergyDayArchive"(site_id,day_start,revision) ON DELETE CASCADE,
    UNIQUE NULLS NOT DISTINCT (site_id,day_start,tariff_id,tariff_schedule_id)
);
CREATE INDEX "EnergyDaySummary_tariff_idx" ON "EnergyDaySummary" (tariff_id);
CREATE INDEX "EnergyDaySummary_schedule_idx" ON "EnergyDaySummary" (tariff_schedule_id);

ALTER TABLE "EnergyDayArchive" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EnergyDaySummary" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "EnergyDayArchive", "EnergyDaySummary" FROM PUBLIC, anon, authenticated;
GRANT ALL ON "EnergyDayArchive", "EnergyDaySummary" TO service_role;

-- Share the finalizer's site lock with every raw writer, including direct SQL.
-- The BEFORE trigger runs in the mutation transaction. Invalidation and mutation
-- either both commit or both roll back. Raw rows remain the recovery source.
CREATE FUNCTION public.invalidate_compact_energy_day() RETURNS trigger
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
CREATE TRIGGER invalidate_compact_energy_day
BEFORE INSERT OR UPDATE OR DELETE ON "EnergyData"
FOR EACH ROW EXECUTE FUNCTION public.invalidate_compact_energy_day();

-- Day boundaries depend on timezone. A correction invalidates all prior local
-- days and shares the same lock so finalization cannot race the change.
CREATE FUNCTION public.invalidate_compact_energy_timezone() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('compact-energy:' || OLD.id, 0));
    DELETE FROM public."EnergyDayArchive" WHERE site_id = OLD.id;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.invalidate_compact_energy_timezone() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.invalidate_compact_energy_timezone() TO service_role;
CREATE TRIGGER invalidate_compact_energy_timezone
BEFORE UPDATE OF timezone ON "Site"
FOR EACH ROW WHEN (OLD.timezone IS DISTINCT FROM NEW.timezone)
EXECUTE FUNCTION public.invalidate_compact_energy_timezone();
