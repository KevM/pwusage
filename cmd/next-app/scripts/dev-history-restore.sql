-- Dev-only. Run by dev-history-restore.sh in the snapshot directory, with
-- -v site, -v project_ref, -v manifest (manifest.json's text) and -v mode:
--   preview      report what a restore would do, change nothing
--   only-if-empty  restore only when the site has no day records now
--   replace      delete the site's current day records, then restore the snapshot
--   keep-newer   keep every current day record; restore only the missing days
-- One transaction: a refusal or failure anywhere changes nothing.
\set ON_ERROR_STOP on
\ir assert-dev-database.sql

BEGIN;
SET LOCAL lock_timeout = '10s';
SELECT set_config('dev_history.site', :'site', true),
       set_config('dev_history.mode', :'mode', true),
       set_config('dev_history.project_ref', :'project_ref', true),
       set_config('dev_history.manifest', :'manifest', true) \gset ignored_

\ir dev-history-functions.sql

-- The snapshot must be for this site, this database and this schema.
DO $$
DECLARE
    manifest json := current_setting('dev_history.manifest')::json;
    site record;
BEGIN
    IF manifest ->> 'kind' IS DISTINCT FROM 'pwusage-dev-history-snapshot' OR manifest ->> 'version' IS DISTINCT FROM '1' THEN
        RAISE EXCEPTION 'Refusing: manifest.json is not a version 1 dev history snapshot';
    END IF;
    IF manifest -> 'site' ->> 'id' IS DISTINCT FROM current_setting('dev_history.site') THEN
        RAISE EXCEPTION 'Refusing: the snapshot is for site %, not %',
            manifest -> 'site' ->> 'id', current_setting('dev_history.site');
    END IF;
    IF manifest -> 'database' ->> 'project_ref' IS DISTINCT FROM NULLIF(current_setting('dev_history.project_ref'), '')
       OR manifest -> 'database' ->> 'name' IS DISTINCT FROM current_database() THEN
        RAISE EXCEPTION 'Refusing: the snapshot was taken from another database';
    END IF;
    IF manifest -> 'schema' ->> 'columns' IS DISTINCT FROM pg_temp.column_signature() THEN
        RAISE EXCEPTION 'Refusing: the day tables'' columns changed since the snapshot (migration % then, % now)',
            manifest -> 'schema' ->> 'migration', pg_temp.migration_version();
    END IF;
    SELECT id, import_lock_id, import_lock_expires INTO site
    FROM public."Site" WHERE id = current_setting('dev_history.site') FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Refusing: there is no site % any more', current_setting('dev_history.site');
    END IF;
    IF site.import_lock_id IS NOT NULL
       AND site.import_lock_expires >= (extract(epoch FROM clock_timestamp()) * 1000)::bigint THEN
        RAISE EXCEPTION 'Refusing: an import holds this site''s lock. Try again in a minute.';
    END IF;
END
$$;
LOCK TABLE public."EnergyDayArchive", public."EnergyDaySummary" IN EXCLUSIVE MODE;

-- The files must reload to exactly the rows the snapshot recorded.
CREATE TEMP TABLE reloaded_archive (LIKE public."EnergyDayArchive") ON COMMIT DROP;
CREATE TEMP TABLE reloaded_summary (LIKE public."EnergyDaySummary") ON COMMIT DROP;
\copy reloaded_archive FROM 'archive.csv' WITH (FORMAT csv, HEADER MATCH)
\copy reloaded_summary FROM 'summary.csv' WITH (FORMAT csv, HEADER MATCH)
DO $$
DECLARE
    manifest json := current_setting('dev_history.manifest')::json;
BEGIN
    IF (SELECT count(*) FROM reloaded_archive)::text IS DISTINCT FROM manifest -> 'archive' ->> 'rows'
       OR (SELECT count(*) FROM reloaded_summary)::text IS DISTINCT FROM manifest -> 'summary' ->> 'rows'
       OR pg_temp.reloaded_archive_digest() IS DISTINCT FROM manifest -> 'archive' ->> 'digest'
       OR pg_temp.reloaded_summary_digest() IS DISTINCT FROM manifest -> 'summary' ->> 'digest' THEN
        RAISE EXCEPTION 'Refusing: the snapshot files do not match manifest.json (changed or corrupt)';
    END IF;
    IF EXISTS (SELECT 1 FROM reloaded_archive WHERE site_id IS DISTINCT FROM current_setting('dev_history.site'))
       OR EXISTS (SELECT 1 FROM reloaded_summary WHERE site_id IS DISTINCT FROM current_setting('dev_history.site')) THEN
        RAISE EXCEPTION 'Refusing: the snapshot files hold rows for another site';
    END IF;
END
$$;

-- What the site holds now, against the snapshot, by day.
CREATE TEMP TABLE day_plan ON COMMIT DROP AS
SELECT coalesce(s.day_start, c.day_start) AS day_start,
       s.day_start IS NOT NULL AS in_snapshot,
       c.day_start IS NOT NULL AS current,
       s.day_start IS NOT NULL AND c.day_start IS NOT NULL AND s::text = c::text AS identical
FROM reloaded_archive s
FULL JOIN (SELECT * FROM public."EnergyDayArchive" WHERE site_id = :'site') c USING (day_start);

\echo 'Snapshot days, current days, both (identical), current only, snapshot only:'
SELECT count(*) FILTER (WHERE in_snapshot) AS snapshot_days,
       count(*) FILTER (WHERE current) AS current_days,
       count(*) FILTER (WHERE in_snapshot AND current) AS both_days,
       count(*) FILTER (WHERE identical) AS identical_days,
       count(*) FILTER (WHERE current AND NOT in_snapshot) AS current_only_days,
       count(*) FILTER (WHERE in_snapshot AND NOT current) AS snapshot_only_days
FROM day_plan;

DO $$
BEGIN
    IF current_setting('dev_history.mode') NOT IN ('preview', 'only-if-empty', 'replace', 'keep-newer') THEN
        RAISE EXCEPTION 'Refusing: unknown mode %', current_setting('dev_history.mode');
    END IF;
    IF current_setting('dev_history.mode') = 'only-if-empty' AND EXISTS (SELECT 1 FROM day_plan WHERE current) THEN
        RAISE EXCEPTION 'Refusing: the site has day records imported since the snapshot. '
            'Choose --replace (discard them) or --keep-newer (keep them, restore only missing days).';
    END IF;
END
$$;

SELECT :'mode' = 'preview' AS dry_run \gset
\if :dry_run
ROLLBACK;
\echo 'Preview only: nothing changed.'
\q
\endif

-- Replace: drop the current records (summaries cascade). Keep-newer and
-- only-if-empty never touch a current record.
DELETE FROM public."EnergyDayArchive" WHERE site_id = :'site' AND :'mode' = 'replace';

-- A summary is restored only with the day record it belongs to.
WITH restored AS (
    INSERT INTO public."EnergyDayArchive"
    SELECT s.* FROM reloaded_archive s
    WHERE NOT EXISTS (SELECT 1 FROM public."EnergyDayArchive" c
                      WHERE c.site_id = s.site_id AND c.day_start = s.day_start)
    RETURNING site_id, day_start, revision
)
INSERT INTO public."EnergyDaySummary"
SELECT ss.* FROM reloaded_summary ss JOIN restored USING (site_id, day_start, revision);

-- The importer only ever moves history_backfill_from later; a replace puts back
-- the snapshot's value along with its records.
UPDATE public."Site"
SET history_backfill_from = (current_setting('dev_history.manifest')::json -> 'site' ->> 'history_backfill_from')::timestamptz
WHERE id = :'site' AND :'mode' = 'replace';

-- Every snapshot day is present again, and a replace is exactly the snapshot.
DO $$
DECLARE
    manifest json := current_setting('dev_history.manifest')::json;
    site text := current_setting('dev_history.site');
BEGIN
    IF EXISTS (SELECT 1 FROM reloaded_archive s
               WHERE NOT EXISTS (SELECT 1 FROM public."EnergyDayArchive" c
                                 WHERE c.site_id = s.site_id AND c.day_start = s.day_start)) THEN
        RAISE EXCEPTION 'Restore check failed: a snapshot day is missing';
    END IF;
    IF current_setting('dev_history.mode') IN ('replace', 'only-if-empty')
       AND (pg_temp.archive_digest(site) IS DISTINCT FROM manifest -> 'archive' ->> 'digest'
            OR pg_temp.summary_digest(site) IS DISTINCT FROM manifest -> 'summary' ->> 'digest') THEN
        RAISE EXCEPTION 'Restore check failed: the restored rows differ from the snapshot';
    END IF;
END
$$;

\echo 'Restored. Day records and summaries now:'
SELECT (SELECT count(*) FROM public."EnergyDayArchive" WHERE site_id = :'site') AS day_records,
       (SELECT count(*) FROM public."EnergyDaySummary" WHERE site_id = :'site') AS summaries;
COMMIT;
