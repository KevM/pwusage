-- Dev-only: shrink the prod -> dev copy after CI has verified migrations
-- against full prod-sized data. Keeps the last 45 days of EnergyData.
-- Set here, not only in the guard: psql ignores a \set made inside an included
-- file when deciding whether the including file stops.
\set ON_ERROR_STOP on
\ir assert-dev-database.sql

SELECT to_regclass('public."EnergyData"') IS NOT NULL AS has_energy_data \gset
\if :has_energy_data
DELETE FROM public."EnergyData" WHERE "timestamp" < now() - interval '45 days';
-- Return the space to the Free plan's disk; plain VACUUM only marks it reusable.
VACUUM FULL public."EnergyData";
\endif
