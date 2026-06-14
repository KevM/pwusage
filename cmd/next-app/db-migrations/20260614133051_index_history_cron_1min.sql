-- Migration: index_history_cron_1min
-- Created at: 2026-06-14T18:30:51.303Z
--
-- Re-schedule the index-history trigger from every 5 min to every 1 min. Paired
-- with batch-concurrent Tesla fetches in the worker (INDEX_HISTORY_FETCH_CONCURRENCY),
-- this drives the one-time historical backfill to completion much faster. Each tick
-- is bounded to <=60s (Vercel Hobby cap) and claims jobs FOR UPDATE SKIP LOCKED, so a
-- 1-min cadence cannot overlap or double-process a site. Reuses existing vault secrets
-- (index_history_cron_target_url, cron_secret). Idempotent: unschedule-if-present,
-- then (re)schedule.

SELECT cron.unschedule('index-history-trigger') FROM cron.job WHERE jobname = 'index-history-trigger';

SELECT cron.schedule(
  'index-history-trigger',
  '* * * * *',
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
