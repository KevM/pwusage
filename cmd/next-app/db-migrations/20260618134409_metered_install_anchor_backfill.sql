-- Anchor each site's earliest metered (non-reporting) Tariff version at the site's
-- commissioning date instead of NULL. The earliest version carries backward over all
-- history; Site.installed is the honest floor (no energy precedes it) and gives the row a
-- concrete date the UI/ordering guard can rely on. Later versions were already dated by the
-- prior detection-date backfill. Comparison plans (reporting_only) are never touched.
-- Idempotent: once set, the row is no longer NULL, so a re-run is a no-op.
UPDATE "Tariff" t
SET effective_from = s.installed::date
FROM "Site" s
WHERE t.site_id = s.id
  AND NOT t.reporting_only
  AND t.effective_from IS NULL
  AND t.version = (
    SELECT MIN(m.version) FROM "Tariff" m
    WHERE m.site_id = t.site_id AND NOT m.reporting_only
  );
