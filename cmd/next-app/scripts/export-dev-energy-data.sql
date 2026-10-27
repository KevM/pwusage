-- Read-only, run against PRODUCTION by CI's verify-db job: writes the only energy
-- history the dev copy keeps. The data dump excludes EnergyDayArchive and
-- EnergyDaySummary, so their full history is never downloaded just to be pruned;
-- scripts/load-dev-energy-data.sql loads these files on dev: day records to
-- dev-day-archive.csv and their summaries to dev-day-summary.csv, in psql's
-- working directory. One REPEATABLE READ snapshot, so the two agree on which
-- sites are kept and every summary matches its record's revision.
-- CI runs it BEFORE the data dump: supabase db dump cannot share a snapshot
-- with it, and exporting first means every Site and Tariff a row references
-- was created before data.sql was taken. The load handles rows whose parents
-- were deleted in between.
--
-- Kept: the last 45 days (the window scripts/prune-dev-copy.sql keeps) for the
-- 5 sites with the most recent live status refresh, plus Harrison, the site used
-- for live tests. A day record is kept when its day starts inside the window.
-- Columns come out in table order (SELECT *), which matches dev because dev's
-- schema is restored from the same prod dump.
\set ON_ERROR_STOP on
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;

\set dev_sites 'SELECT id FROM public."Site" WHERE id = ''2252268092126997'' UNION SELECT id FROM (SELECT id FROM public."Site" WHERE last_live_refresh_at > 0 ORDER BY last_live_refresh_at DESC LIMIT 5) AS recently_live'

COPY (
    SELECT a.*
    FROM public."EnergyDayArchive" a
    WHERE a.day_start >= now() - interval '45 days'
      AND a.site_id IN (:dev_sites)
    ORDER BY a.site_id, a.day_start
) TO STDOUT WITH (FORMAT csv, HEADER true) \g dev-day-archive.csv

COPY (
    SELECT s.*
    FROM public."EnergyDaySummary" s
    JOIN public."EnergyDayArchive" a USING (site_id, day_start, revision)
    WHERE a.day_start >= now() - interval '45 days'
      AND a.site_id IN (:dev_sites)
    ORDER BY s.site_id, s.day_start
) TO STDOUT WITH (FORMAT csv, HEADER true) \g dev-day-summary.csv

COMMIT;
