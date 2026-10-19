-- Read-only, run against PRODUCTION by CI's verify-db job: writes, as CSV on
-- stdout, the only EnergyData the dev copy keeps. The data dump excludes
-- EnergyData (-x public.EnergyData), so its full history is never downloaded
-- just to be pruned; scripts/load-dev-energy-data.sql loads this file on dev.
-- CI runs it BEFORE the data dump: supabase db dump cannot share a snapshot
-- with it, and exporting first means every Site and Tariff a row references
-- was created before data.sql was taken. The load handles rows whose parents
-- were deleted in between.
--
-- Kept: the last 45 days (the window scripts/prune-dev-copy.sql keeps) for the
-- 5 sites with the most recent live status refresh, plus Harrison, the site used
-- for live tests. Columns come out in table order (SELECT *), which matches dev
-- because dev's schema is restored from the same prod dump.
COPY (
    SELECT e.*
    FROM public."EnergyData" e
    WHERE e."timestamp" >= now() - interval '45 days'
      AND e.site_id IN (
          SELECT id FROM public."Site" WHERE id = '2252268092126997'
          UNION
          SELECT id FROM (
              SELECT id FROM public."Site"
              WHERE last_live_refresh_at > 0
              ORDER BY last_live_refresh_at DESC
              LIMIT 5
          ) AS recently_live
      )
    ORDER BY e.site_id, e."timestamp"
) TO STDOUT WITH (FORMAT csv, HEADER true);
