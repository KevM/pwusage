-- Enable the extensions if they are not already active
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- Upsert the battery_restore_cron_target_url dynamically using vault security definer functions.
-- This avoids direct table writes and resolves view permission issues.
DO $$
DECLARE
  secret_id uuid;
  old_secret_id uuid;
BEGIN
  -- Clean up deprecated vault secret if it exists
  SELECT id INTO old_secret_id FROM vault.decrypted_secrets WHERE name = 'cron_target_url';
  IF old_secret_id IS NOT NULL THEN
    PERFORM vault.delete_secret(old_secret_id);
  END IF;

  SELECT id INTO secret_id FROM vault.decrypted_secrets WHERE name = 'battery_restore_cron_target_url';
  
  IF secret_id IS NOT NULL THEN
    PERFORM vault.update_secret(
      secret_id,
      '{{BATTERY_RESTORE_CRON_TARGET_URL}}',
      'battery_restore_cron_target_url',
      'Vercel API battery restore cron endpoint URL'
    );
  ELSE
    PERFORM vault.create_secret(
      '{{BATTERY_RESTORE_CRON_TARGET_URL}}',
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
      '{{CRON_SECRET}}',
      'cron_secret',
      'Vercel cron endpoint authorization bearer token'
    );
  ELSE
    PERFORM vault.create_secret(
      '{{CRON_SECRET}}',
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
