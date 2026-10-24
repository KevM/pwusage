-- Migration: history_archive_cron
-- Created at: 2026-10-24T18:10:00.000Z

-- Hourly trigger for the history archive job (/api/cron/cleanup). The Vercel
-- cron in vercel.json only runs it once a day, and each run archives at most
-- HISTORY_ARCHIVE_MAX_DAYS days (default 2, max 7) within a 30 s budget, which
-- cannot keep up with one new day per active site per day. Hourly gives 48
-- days/day at the default. The job takes an advisory lock, so this and the
-- daily Vercel cron never overlap, and it does nothing unless the deployment
-- has HISTORY_ARCHIVE_JOB_ENABLED=true and "HistoryArchiveControl" is unpaused.
--
-- At :23, clear of the 15-minute battery monitor (:00/:15/:30/:45), the activity
-- delivery (:02/:07/...) and gap heal (:37 every 2 hours). cron.schedule upserts
-- by job name, so re-running this migration is safe.
--
-- The target is derived from the existing restore-reserve Vault secret, so prod
-- and the dev copy each call their own deployment. If that secret ever stops
-- ending in /api/cron/restore-reserve, the WHERE clause makes the job call
-- nothing rather than the monitor. The route allows 60 seconds; pg_net allows 65.
SELECT cron.schedule(
  'history-archive-trigger',
  '23 * * * *',
  $$
  SELECT net.http_get(
    url := target.url,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret' LIMIT 1)
    ),
    timeout_milliseconds := 65000
  )
  FROM (
    SELECT regexp_replace(decrypted_secret, '/api/cron/restore-reserve$', '/api/cron/cleanup') AS url
    FROM vault.decrypted_secrets WHERE name = 'battery_restore_cron_target_url' LIMIT 1
  ) target
  WHERE target.url LIKE 'https://%/api/cron/cleanup';
  $$
);
