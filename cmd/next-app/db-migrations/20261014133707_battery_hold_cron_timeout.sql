-- Migration: battery_hold_cron_timeout
-- Created at: 2026-10-14T18:37:07.631Z

-- TODO: If this migration creates a new table, you MUST enable Row Level Security (RLS)!
-- ALTER TABLE "MyNewTable" ENABLE ROW LEVEL SECURITY;
-- REVOKE ALL ON "MyNewTable" FROM PUBLIC;
-- REVOKE ALL ON "MyNewTable" FROM anon;
-- REVOKE ALL ON "MyNewTable" FROM authenticated;
-- GRANT ALL ON "MyNewTable" TO service_role;
--
-- If using serial/sequence:
-- GRANT ALL ON SEQUENCE "MyNewTable_id_seq" TO service_role;

-- Verified read-only on production: pg_net 0.20.0, http_get has the named
-- integer timeout_milliseconds parameter (default 5000). Keep 15-minute cadence.
-- The endpoint explicitly allows 60 seconds; the caller allows 5s transport slack.
SELECT cron.schedule(
  'restore-reserve-trigger',
  '*/15 * * * *',
  $$
  SELECT net.http_get(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'battery_restore_cron_target_url' LIMIT 1),
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret' LIMIT 1)
    ),
    timeout_milliseconds := 65000
  );
  $$
);
