-- Backfill effective_from for metered (non-reporting) Tariff versions that predate
-- effective-date stamping. Per site, leave the earliest version null (it carries backward),
-- and date every later null version to its own detection timestamp (Tariff.updated).
-- Idempotent: after running, the affected rows are no longer null, so a re-run is a no-op.
-- Comparison plans (reporting_only) are never touched — they own their dates.
UPDATE "Tariff" t
SET effective_from = t.updated::date
WHERE NOT t.reporting_only
  AND t.effective_from IS NULL
  AND t.version > (
    SELECT MIN(m.version)
    FROM "Tariff" m
    WHERE m.site_id = t.site_id AND NOT m.reporting_only
  );
