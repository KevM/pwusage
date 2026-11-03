-- Dev-only. Run by dev-history-reset.sh in the new snapshot directory, with
-- -v site, -v expect_name and -v project_ref. Saves one site's day records and
-- summaries, proves the saved files reload to identical rows, then deletes the
-- site's history, all in one transaction: any failure deletes nothing.
\set ON_ERROR_STOP on
\ir assert-dev-database.sql

BEGIN;
-- Fail rather than wait behind a long import.
SET LOCAL lock_timeout = '10s';
SELECT set_config('dev_history.site', :'site', true),
       set_config('dev_history.expect_name', :'expect_name', true) \gset ignored_

-- Holding the Site row blocks an import from taking the site's lock until this
-- commits; one that already holds an unexpired lock is refused.
DO $$
DECLARE
    site record;
BEGIN
    SELECT id, name, import_lock_id, import_lock_expires INTO site
    FROM public."Site" WHERE id = current_setting('dev_history.site') FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Refusing: there is no site %', current_setting('dev_history.site');
    END IF;
    IF site.name IS DISTINCT FROM current_setting('dev_history.expect_name') THEN
        RAISE EXCEPTION 'Refusing: site % is named "%", not "%"',
            site.id, site.name, current_setting('dev_history.expect_name');
    END IF;
    IF site.import_lock_id IS NOT NULL
       AND site.import_lock_expires >= (extract(epoch FROM clock_timestamp()) * 1000)::bigint THEN
        RAISE EXCEPTION 'Refusing: an import holds this site''s lock. Try again in a minute.';
    END IF;
END
$$;
-- Other writers (gap healing, other sites' imports) wait until commit; reads go on.
LOCK TABLE public."EnergyDayArchive", public."EnergyDaySummary" IN EXCLUSIVE MODE;

\ir dev-history-functions.sql

COPY (SELECT a.* FROM public."EnergyDayArchive" a WHERE a.site_id = :'site' ORDER BY a.day_start)
TO STDOUT WITH (FORMAT csv, HEADER true) \g archive.csv
COPY (SELECT s.* FROM public."EnergyDaySummary" s WHERE s.site_id = :'site'
      ORDER BY s.day_start, s.tariff_id, s.tariff_schedule_id NULLS FIRST)
TO STDOUT WITH (FORMAT csv, HEADER true) \g summary.csv

-- The files must reload to exactly the rows about to be deleted.
CREATE TEMP TABLE reloaded_archive (LIKE public."EnergyDayArchive") ON COMMIT DROP;
CREATE TEMP TABLE reloaded_summary (LIKE public."EnergyDaySummary") ON COMMIT DROP;
\copy reloaded_archive FROM 'archive.csv' WITH (FORMAT csv, HEADER MATCH)
\copy reloaded_summary FROM 'summary.csv' WITH (FORMAT csv, HEADER MATCH)
DO $$
BEGIN
    IF pg_temp.archive_digest(current_setting('dev_history.site')) IS DISTINCT FROM pg_temp.reloaded_archive_digest()
       OR pg_temp.summary_digest(current_setting('dev_history.site')) IS DISTINCT FROM pg_temp.reloaded_summary_digest() THEN
        RAISE EXCEPTION 'Refusing: the saved files do not reload to the same rows; nothing was deleted';
    END IF;
END
$$;

\pset tuples_only on
\pset format unaligned
SELECT json_build_object(
    'kind', 'pwusage-dev-history-snapshot',
    'version', 1,
    'taken_at', now(),
    'site', (SELECT json_build_object(
        'id', s.id, 'name', s.name, 'timezone', s.timezone,
        'history_backfill_from', s.history_backfill_from,
        'history_migrated_at', s.history_migrated_at)
        FROM public."Site" s WHERE s.id = :'site'),
    'database', json_build_object(
        'project_ref', NULLIF(:'project_ref', ''),
        'name', current_database(),
        'server_version_num', current_setting('server_version_num')),
    'schema', json_build_object(
        'migration', pg_temp.migration_version(),
        'columns', pg_temp.column_signature()),
    'archive', (SELECT json_build_object(
        'rows', count(*), 'first_day', min(day_start), 'last_day', max(day_start),
        'digest', pg_temp.reloaded_archive_digest()) FROM reloaded_archive),
    'summary', json_build_object(
        'rows', (SELECT count(*) FROM reloaded_summary),
        'digest', pg_temp.reloaded_summary_digest())
) \g manifest.json
\pset tuples_only off
\pset format aligned

-- Summaries go with their day records (ON DELETE CASCADE).
DELETE FROM public."EnergyDayArchive" WHERE site_id = :'site';
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM public."EnergyDaySummary" WHERE site_id = current_setting('dev_history.site')) THEN
        RAISE EXCEPTION 'Refusing: summaries remained after deleting the day records';
    END IF;
END
$$;
COMMIT;
