-- Migration: index_history_cron_5min
-- Created at: 2026-06-14T17:00:22.024Z
--
-- Re-schedule the index-history trigger from every 15 min to every 5 min so a
-- large one-time historical backfill finishes ~3x faster. Each worker tick is
-- bounded to <=60s (Vercel Hobby cap) and claims jobs FOR UPDATE SKIP LOCKED,
-- so a 5-min cadence cannot overlap or double-process. Reuses the existing
-- vault secrets (index_history_cron_target_url, cron_secret) created by
-- 20260613222439_index_history_cron_trigger.sql. Idempotent: unschedule-if-
-- present, then (re)schedule.

SELECT cron.unschedule('index-history-trigger') FROM cron.job WHERE jobname = 'index-history-trigger';

SELECT cron.schedule(
  'index-history-trigger',
  '*/5 * * * *',
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
