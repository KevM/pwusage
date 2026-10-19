-- Dev-only: loads the EnergyData subset made by scripts/export-dev-energy-data.sql,
-- read from psql's stdin. CI runs it in the restore transaction, after data.sql
-- (which has every other table, EnergyDayArchive included) and before the scrub:
--   psql --single-transaction -f data.sql -f scripts/load-dev-energy-data.sql \
--        -f scripts/sanitize-dev-copy.sql < dev-energy-data.csv
-- Set here, not only in the guard: psql ignores a \set made inside an included
-- file when deciding whether the including file stops.
\set ON_ERROR_STOP on
\ir assert-dev-database.sql

-- Triggers stay paused, as in the dump's own data load: the compact-archive
-- trigger would otherwise reject or invalidate days while they are half loaded.
-- HEADER MATCH refuses an export whose columns differ from the dev table.
SET session_replication_role = replica;
\copy public."EnergyData" FROM pstdin WITH (FORMAT csv, HEADER MATCH)
-- Back on, so the archive deletes below cascade to EnergyDaySummary.
RESET session_replication_role;

-- Archive days whose raw rows were not copied: drop them, as deleting those raw
-- rows would have (invalidate_compact_energy_day). Without this, a later write
-- to such a day fails with "Raw archive source incomplete". Archive-only days
-- (raw_pruned) never had raw rows to copy and stay.
DO $$
BEGIN
    IF to_regclass('public."EnergyDayArchive"') IS NOT NULL THEN
        EXECUTE $sql$
            DELETE FROM public."EnergyDayArchive" a
            WHERE NOT a.raw_pruned
              AND a.sample_count <> (
                  SELECT count(*) FROM public."EnergyData" e
                  WHERE e.site_id = a.site_id AND e."timestamp" >= a.day_start AND e."timestamp" < a.day_end)
        $sql$;
    END IF;
END
$$;

-- Sites left without readings look idle (0 is the column's "never" value), so
-- beta's live-site crons such as heal-gaps do not re-import their history.
UPDATE public."Site" s SET last_live_refresh_at = 0
WHERE s.last_live_refresh_at <> 0
  AND NOT EXISTS (SELECT 1 FROM public."EnergyData" e WHERE e.site_id = s.id);
