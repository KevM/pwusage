CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

DO $$
DECLARE secret_id uuid;
BEGIN
  SELECT id INTO secret_id FROM vault.decrypted_secrets WHERE name = 'rollup_cron_target_url';
  IF secret_id IS NOT NULL THEN
    PERFORM vault.update_secret(secret_id, $u${{ROLLUP_CRON_TARGET_URL}}$u$, 'rollup_cron_target_url', 'Vercel hourly rollup cron URL');
  ELSE
    PERFORM vault.create_secret($u${{ROLLUP_CRON_TARGET_URL}}$u$, 'rollup_cron_target_url', 'Vercel hourly rollup cron URL');
  END IF;
END $$;

-- cron_secret is already managed by the restore-reserve migration; reuse it.

SELECT cron.unschedule('rollup-trigger') FROM cron.job WHERE jobname = 'rollup-trigger';

SELECT cron.schedule(
  'rollup-trigger',
  '0 * * * *',
  $$
  SELECT net.http_get(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'rollup_cron_target_url' LIMIT 1),
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret' LIMIT 1)
    ),
    timeout_milliseconds := 5000
  );
  $$
);
