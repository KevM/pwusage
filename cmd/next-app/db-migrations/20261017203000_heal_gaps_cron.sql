-- Migration: heal_gaps_cron
-- Created at: 2026-10-17T20:30:00.000Z

-- Bounded trailing-window EnergyData gap heal (/api/cron/heal-gaps). Only sites
-- with a live status refresh (web, mobile, TRMNL, battery hold) in the last
-- 7 days are healed; idle sites cost nothing. Each run
-- audits the last 14 complete site-local days per site (one coverage query) and
-- imports at most 3 missing day windows per site from Tesla, newest first,
-- within a 35 s budget. Complete sites cost no Tesla calls. Anything still
-- missing is re-planned by the next run, so a fully empty 14-day window heals
-- in about 5 runs (10 hours).
--
-- Every 2 hours at :37, clear of the 15-minute battery monitor (:00/:15/:30/:45)
-- and the activity delivery (:02/:07/...). cron.schedule upserts by job name, so
-- re-running this migration is safe.
--
-- The target is derived from the existing restore-reserve Vault secret, so prod
-- and the dev copy each call their own deployment. If that secret ever stops
-- ending in /api/cron/restore-reserve, the WHERE clause makes the job call
-- nothing rather than the monitor. The route allows 60 seconds; pg_net allows 65.
SELECT cron.schedule(
  'heal-gaps-trigger',
  '37 */2 * * *',
  $$
  SELECT net.http_get(
    url := target.url,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret' LIMIT 1)
    ),
    timeout_milliseconds := 65000
  )
  FROM (
    SELECT regexp_replace(decrypted_secret, '/api/cron/restore-reserve$', '/api/cron/heal-gaps') AS url
    FROM vault.decrypted_secrets WHERE name = 'battery_restore_cron_target_url' LIMIT 1
  ) target
  WHERE target.url LIKE 'https://%/api/cron/heal-gaps';
  $$
);
