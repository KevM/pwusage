-- Migration: drop_energy_data
-- Created at: 2026-10-27T12:00:00.000Z

-- Single compact store cutover (docs/plans/2026-10-24-day-record-v2.md, slice 5).
-- Day records ("EnergyDayArchive" + "EnergyDaySummary") are the only energy
-- history. Before this ran in production every raw day had a v2 record and no
-- v1 record remained, so dropping the raw table loses no history.
--
-- Removes the raw 5-minute table, its dual-format trigger and functions, the
-- history archive job's control tables and its hourly pg_cron trigger. Every
-- statement is idempotent.

DO $$
BEGIN
    -- Nested: plpgsql resolves cron.job when it plans the inner statement.
    IF to_regclass('cron.job') IS NOT NULL THEN
        IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'history-archive-trigger') THEN
            PERFORM cron.unschedule('history-archive-trigger');
        END IF;
    END IF;
END $$;

DROP TABLE IF EXISTS "HistoryArchiveRetry";
DROP TABLE IF EXISTS "HistoryArchiveControl";

-- CASCADE drops the invalidate_compact_energy_day trigger and the indexes.
DROP TABLE IF EXISTS "EnergyData" CASCADE;
DROP FUNCTION IF EXISTS public.invalidate_compact_energy_day();
DROP FUNCTION IF EXISTS public.compact_raw_day_digest(text, timestamptz, timestamptz);

-- Day records are keyed by site-local midnight, so a timezone change must re-key
-- them. They are now the only copy of the history: refuse the change while any
-- exist instead of deleting them. Tesla does not change a site's timezone, so a
-- correction is a manual step: delete the site's records (only those of a site
-- with working Tesla tokens can be refetched), change the timezone, refetch.
CREATE OR REPLACE FUNCTION public.invalidate_compact_energy_timezone()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('compact-energy:' || OLD.id, 0));
    IF EXISTS (SELECT 1 FROM public."EnergyDayArchive" WHERE site_id = OLD.id) THEN
        RAISE EXCEPTION 'Site has energy day records keyed to its current timezone; delete them (and refetch from Tesla) before changing it';
    END IF;
    RETURN NEW;
END;
$function$;
