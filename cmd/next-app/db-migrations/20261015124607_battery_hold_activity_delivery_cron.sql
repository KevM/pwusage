-- Migration: battery_hold_activity_delivery_cron
-- Created at: 2026-10-15T17:46:07.583Z

-- Live Activity delivery trigger, separate from the 15-minute battery monitor.
-- Every 5 minutes at :02, :07, ... so each run lands about 2 minutes after a
-- 15-minute monitor run (:00/:15/:30/:45, up to ~60 s) and picks up its updates.
-- Manual stops wait at most 5 minutes. Each idle run reconnects to the database
-- (the pool idles out after 30 s), so cadence drives egress. The route is a no-op
-- (no database work, no Apple calls) until APNs credentials are configured, and
-- makes no Apple calls while nothing is pending. A failed or timed-out call changes nothing: claims lapse
-- and pending rows are retried by the next run.
--
-- The target is derived from the existing restore-reserve Vault secret, so prod
-- and the dev copy each call their own deployment. If that secret ever stops
-- ending in /api/cron/restore-reserve, the WHERE clause makes the job call
-- nothing rather than the monitor. The route allows 30 seconds; pg_net allows 35.
SELECT cron.schedule(
  'battery-hold-activity-delivery-trigger',
  '2-59/5 * * * *',
  $$
  SELECT net.http_get(
    url := target.url,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret' LIMIT 1)
    ),
    timeout_milliseconds := 35000
  )
  FROM (
    SELECT regexp_replace(decrypted_secret, '/api/cron/restore-reserve$', '/api/cron/battery-hold-activity-delivery') AS url
    FROM vault.decrypted_secrets WHERE name = 'battery_restore_cron_target_url' LIMIT 1
  ) target
  WHERE target.url LIKE 'https://%/api/cron/battery-hold-activity-delivery';
  $$
);
