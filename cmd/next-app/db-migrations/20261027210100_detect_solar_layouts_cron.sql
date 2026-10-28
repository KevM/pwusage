-- Migration: detect_solar_layouts_cron
-- Created at: 2026-10-27T21:01:00.000Z

-- Automatic solar layout detection (/api/cron/detect-solar-layouts). Each run
-- takes up to 5 due sites: owner has the solar-forecast-beta role, a location
-- is stored, no detection in the last 30 days and no attempt in the last 24
-- hours. Sites without the role cost one small query and nothing else.
--
-- Egress, measured on the Dev DB for Harrison: the day records and summaries
-- the history reader returns are ~4.3 KB per day on the wire (text protocol;
-- 194 KB for the 45-day dev slice), so one detection over a full year of
-- history reads ~1.6 MB; the due-site query is under 1 KB. A site is detected
-- at most once per 30 days (or retried after 24 hours if a run fails), so
-- monthly egress is about 1.6 MB per beta site. Detection itself is CPU only
-- (slowest research site 7.7 s, Harrison 4.1 s on a laptop).
--
-- Every 3 hours at :53, clear of the 15-minute battery monitor (:00/:15/:30/:45),
-- the activity delivery (:02/:07/...), gap heal (:37 every 2 hours) and the
-- history archive (:23 hourly). cron.schedule upserts by job name, so re-running
-- this migration is safe.
--
-- The target is derived from the existing restore-reserve Vault secret, so prod
-- and the dev copy each call their own deployment. If that secret ever stops
-- ending in /api/cron/restore-reserve, the WHERE clause makes the job call
-- nothing rather than the monitor. The route allows 60 seconds; pg_net allows 65.
SELECT cron.schedule(
  'detect-solar-layouts-trigger',
  '53 */3 * * *',
  $$
  SELECT net.http_get(
    url := target.url,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret' LIMIT 1)
    ),
    timeout_milliseconds := 65000
  )
  FROM (
    SELECT regexp_replace(decrypted_secret, '/api/cron/restore-reserve$', '/api/cron/detect-solar-layouts') AS url
    FROM vault.decrypted_secrets WHERE name = 'battery_restore_cron_target_url' LIMIT 1
  ) target
  WHERE target.url LIKE 'https://%/api/cron/detect-solar-layouts';
  $$
);
