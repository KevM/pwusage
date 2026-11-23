-- Migration: battery_saver_cron_merge_and_cron_prune
-- Created at: 2026-11-23T20:14:48.830Z

-- TODO: If this migration creates a new table, you MUST enable Row Level Security (RLS)!
-- ALTER TABLE "MyNewTable" ENABLE ROW LEVEL SECURITY;
-- REVOKE ALL ON "MyNewTable" FROM PUBLIC;
-- REVOKE ALL ON "MyNewTable" FROM anon;
-- REVOKE ALL ON "MyNewTable" FROM authenticated;
-- GRANT ALL ON "MyNewTable" TO service_role;
--
-- If using serial/sequence:
-- GRANT ALL ON SEQUENCE "MyNewTable_id_seq" TO service_role;

-- 1. Battery Saver runs as one job. /api/cron/restore-reserve now checks every
-- active hold and then sends the Live Activity updates that check produced, so
-- the separate battery-hold-activity-delivery-trigger is removed. It runs every
-- 5 minutes (was 15) but calls the app only when there is work:
--   * an active hold to check;
--   * an activity row with an unsent update ('pending') or a live registration
--     ('current') whose hold may have ended without a successful sync;
--   * a row due to expire, or retired 24 hours ago and due for deletion
--     (ACTIVITY_RETENTION_HOURS in battery-hold-activity-repo.ts).
-- Idle, it costs one EXISTS query and a pg_cron history row, and no Vercel call.
SELECT cron.schedule(
  'restore-reserve-trigger',
  '*/5 * * * *',
  $$
  SELECT net.http_get(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'battery_restore_cron_target_url' LIMIT 1),
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret' LIMIT 1)
    ),
    timeout_milliseconds := 65000
  )
  WHERE EXISTS (SELECT 1 FROM public."BatteryHold" WHERE status = 'active')
     OR EXISTS (
       SELECT 1 FROM public."BatteryHoldActivity"
       WHERE delivery_state IN ('pending', 'current')
          OR (delivery_state <> 'disabled' AND expires_at <= now())
          OR expires_at <= now() - interval '24 hours'
          OR (delivery_state = 'disabled' AND updated_at <= now() - interval '24 hours')
     );
  $$
);

DO $$
BEGIN
    -- Nested: plpgsql resolves cron.job when it plans the inner statement.
    IF to_regclass('cron.job') IS NOT NULL THEN
        IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'battery-hold-activity-delivery-trigger') THEN
            PERFORM cron.unschedule('battery-hold-activity-delivery-trigger');
        END IF;
    END IF;
END $$;

-- 2. Tariff re-attribution: every 5 minutes (was every minute). The gate is
-- unchanged; a re-attribution starting a few minutes later is invisible to
-- users, and each idle check still writes a pg_cron history row.
SELECT cron.schedule(
  'reattribute-tariffs-trigger',
  '*/5 * * * *',
  $$
  SELECT net.http_get(
    url := target.url,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret' LIMIT 1)
    ),
    timeout_milliseconds := 65000
  )
  FROM (
    SELECT regexp_replace(decrypted_secret, '/api/cron/restore-reserve$', '/api/cron/reattribute-tariffs') AS url
    FROM vault.decrypted_secrets WHERE name = 'battery_restore_cron_target_url' LIMIT 1
  ) target
  WHERE target.url LIKE 'https://%/api/cron/reattribute-tariffs'
    AND EXISTS (
      SELECT 1 FROM public."SiteTariffReattribution"
      WHERE status = 'pending'
         OR (status = 'running' AND updated_at < now() - interval '2 minutes')
    );
  $$
);

-- 3. pg_cron keeps a cron.job_run_details row for every run, gated or not, and
-- never deletes them: by 2026-11-23 Prod held 46k rows (46 MB of a 110 MB
-- database, against the 500 MB quota Prod and Dev share). Keep 7 days, pruned
-- nightly at 03:41 UTC, clear of the 5-minute jobs. DELETE frees space for reuse
-- but does not shrink the file; reclaiming the existing 46 MB needs a one-off
-- VACUUM FULL cron.job_run_details, which cannot run inside a migration.
SELECT cron.schedule(
  'cron-run-history-prune',
  '41 3 * * *',
  $$DELETE FROM cron.job_run_details WHERE start_time < now() - interval '7 days'$$
);
