-- Enable the extensions if they are not already active
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- Upsert the battery_restore_cron_target_url dynamically using vault security definer functions.
-- This avoids direct table writes and resolves view permission issues.
DO $$
DECLARE
  secret_id uuid;
BEGIN
  -- Clean up deprecated vault secret if it exists
  DELETE FROM vault.secrets WHERE name = 'cron_target_url';

  SELECT id INTO secret_id FROM vault.decrypted_secrets WHERE name = 'battery_restore_cron_target_url';
  
  IF secret_id IS NOT NULL THEN
    PERFORM vault.update_secret(
      secret_id,
      $target_url_val${{BATTERY_RESTORE_CRON_TARGET_URL}}$target_url_val$,
      'battery_restore_cron_target_url',
      'Vercel API battery restore cron endpoint URL'
    );
  ELSE
    PERFORM vault.create_secret(
      $target_url_val${{BATTERY_RESTORE_CRON_TARGET_URL}}$target_url_val$,
      'battery_restore_cron_target_url',
      'Vercel API battery restore cron endpoint URL'
    );
  END IF;
END;
$$;


-- Upsert the cron_secret using the placeholder {{CRON_SECRET}}
-- This placeholder is replaced at deployment time by GitHub Actions
-- using the CRON_SECRET repository secret.
DO $$
DECLARE
  secret_id uuid;
BEGIN
  SELECT id INTO secret_id FROM vault.decrypted_secrets WHERE name = 'cron_secret';
  
  IF secret_id IS NOT NULL THEN
    PERFORM vault.update_secret(
      secret_id,
      $cron_secret_val${{CRON_SECRET}}$cron_secret_val$,
      'cron_secret',
      'Vercel cron endpoint authorization bearer token'
    );
  ELSE
    PERFORM vault.create_secret(
      $cron_secret_val${{CRON_SECRET}}$cron_secret_val$,
      'cron_secret',
      'Vercel cron endpoint authorization bearer token'
    );
  END IF;
END;
$$;

-- Unschedule old cron trigger if it exists
SELECT cron.unschedule('restore-reserve-trigger')
FROM cron.job
WHERE jobname = 'restore-reserve-trigger';

-- Schedule the 15-minute HTTP check
SELECT cron.schedule(
  'restore-reserve-trigger',
  '*/15 * * * *',
  $$
  SELECT net.http_get(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'battery_restore_cron_target_url' LIMIT 1),
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret' LIMIT 1)
    )
  );
  $$
);
