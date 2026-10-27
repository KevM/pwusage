-- Dev-only: runs after CI's migrations on the prod -> dev copy. Keeps the last
-- 45 days of day records (EnergyDayArchive, with their EnergyDaySummary rows by
-- cascade). The copy already arrives with only that
-- window (export-dev-energy-data.sql, which must use the same interval), so this
-- is a safety net.
-- Set here, not only in the guard: psql ignores a \set made inside an included
-- file when deciding whether the including file stops.
\set ON_ERROR_STOP on
\ir assert-dev-database.sql

SELECT to_regclass('public."EnergyDayArchive"') IS NOT NULL AS has_day_records \gset
\if :has_day_records
DELETE FROM public."EnergyDayArchive" WHERE day_start < now() - interval '45 days';
VACUUM FULL public."EnergyDayArchive";
VACUUM FULL public."EnergyDaySummary";
\endif
