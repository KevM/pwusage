-- Migration: conditional_index_history_cron
-- Created at: 2026-06-14T21:33:38Z
--
-- Optimize index-history-trigger to query "RollupBackfill" first.
-- It only sends an HTTP request to Vercel if there is active history indexing to perform.

SELECT cron.unschedule('index-history-trigger') FROM cron.job WHERE jobname = 'index-history-trigger';

SELECT cron.schedule(
  'index-history-trigger',
  '* * * * *',
  $$
  SELECT CASE 
    WHEN EXISTS (
      SELECT 1 FROM "RollupBackfill"
      WHERE status = 'pending'
         OR (status = 'running' AND updated_at < now() - interval '3 minutes')
         OR (status = 'error' AND updated_at < now() - interval '1 hour' AND (last_error IS NULL OR last_error NOT LIKE '[attempts=5]%'))
    ) THEN (
      SELECT net.http_get(
        url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'index_history_cron_target_url' LIMIT 1),
        headers := jsonb_build_object(
          'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret' LIMIT 1)
        ),
        timeout_milliseconds := 5000
      )
    )
    ELSE NULL
  END;
  $$
);
