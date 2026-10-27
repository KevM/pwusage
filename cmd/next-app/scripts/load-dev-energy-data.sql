-- Dev-only: loads the energy history made by scripts/export-dev-energy-data.sql:
-- the day records and their summaries from dev-day-archive.csv and
-- dev-day-summary.csv in psql's working directory. CI runs it in the restore
-- transaction, after data.sql (which has every other table) and before the scrub:
--   psql --single-transaction -f data.sql -f scripts/load-dev-energy-data.sql \
--        -f scripts/sanitize-dev-copy.sql
-- Set here, not only in the guard: psql ignores a \set made inside an included
-- file when deciding whether the including file stops.
\set ON_ERROR_STOP on
\ir assert-dev-database.sql

-- Triggers stay paused, as in the dump's own data load.
-- HEADER MATCH refuses an export whose columns differ from the dev table.
SET session_replication_role = replica;
\copy public."EnergyDayArchive" FROM 'dev-day-archive.csv' WITH (FORMAT csv, HEADER MATCH)
\copy public."EnergyDaySummary" FROM 'dev-day-summary.csv' WITH (FORMAT csv, HEADER MATCH)
-- Back on, so the archive deletes below cascade to EnergyDaySummary.
RESET session_replication_role;

-- The export runs just before the data dump, in its own transaction, so a Site,
-- Tariff or TariffSchedule deleted on prod in between can be referenced here but
-- missing from data.sql. Day records whose Site was deleted go (ON DELETE CASCADE),
-- and so does a whole day whose summaries name a Tariff or TariffSchedule deleted
-- in between: those keys have no ON DELETE action, and a record is all or nothing.
DELETE FROM public."EnergyDayArchive" a
WHERE NOT EXISTS (SELECT 1 FROM public."Site" s WHERE s.id = a.site_id)
   OR EXISTS (SELECT 1 FROM public."EnergyDaySummary" ds
              WHERE ds.site_id = a.site_id AND ds.day_start = a.day_start
                AND (NOT EXISTS (SELECT 1 FROM public."Tariff" t WHERE t.id = ds.tariff_id)
                     OR (ds.tariff_schedule_id IS NOT NULL
                         AND NOT EXISTS (SELECT 1 FROM public."TariffSchedule" ts WHERE ts.id = ds.tariff_schedule_id))));

-- Sites left without readings look idle (0 is the column's "never" value), so
-- beta's live-site crons such as heal-gaps do not re-import their history.
UPDATE public."Site" s SET last_live_refresh_at = 0
WHERE s.last_live_refresh_at <> 0
  AND NOT EXISTS (SELECT 1 FROM public."EnergyDayArchive" a WHERE a.site_id = s.id);
