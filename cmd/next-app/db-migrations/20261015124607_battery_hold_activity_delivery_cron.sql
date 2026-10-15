-- Migration: battery_hold_activity_delivery_cron
-- Created at: 2026-10-15T17:46:07.583Z

-- Live Activity delivery trigger, separate from the 15-minute battery monitor.
-- Provisionally once a minute. The route is a no-op (no database work, no Apple
-- calls) until APNs credentials are configured, and does no Apple calls while
-- nothing is pending. A failed or timed-out call changes nothing: claims lapse
-- and pending rows are retried by the next run.
--
-- The target is derived from the existing restore-reserve Vault secret, so prod
-- and the dev copy each call their own deployment. If that secret ever stops
-- ending in /api/cron/restore-reserve, the WHERE clause makes the job call
-- nothing rather than the monitor. The route allows 30 seconds; pg_net allows 35.
SELECT cron.schedule(
  'battery-hold-activity-delivery-trigger',
  '* * * * *',
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
