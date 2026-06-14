-- Migration: index_history_cron_2min
-- Created at: 2026-06-14T20:57:41.315Z
--
-- Re-schedule the index-history trigger from every 1 min to every 2 min.

SELECT cron.unschedule('index-history-trigger') FROM cron.job WHERE jobname = 'index-history-trigger';

SELECT cron.schedule(
  'index-history-trigger',
  '*/2 * * * *',
  $$
  SELECT net.http_get(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'index_history_cron_target_url' LIMIT 1),
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret' LIMIT 1)
    ),
    timeout_milliseconds := 5000
  );
  $$
);
