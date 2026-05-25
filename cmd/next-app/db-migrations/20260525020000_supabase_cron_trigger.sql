-- Enable the extensions if they are not already active
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- Grant usage on vault schema and decrypted_secrets view to postgres role
-- so the backend database connection and maintenance scripts can access it.
GRANT USAGE ON SCHEMA vault TO postgres;
GRANT SELECT, INSERT, UPDATE, DELETE ON vault.decrypted_secrets TO postgres;

-- Insert the cron_target_url (not secret, committed to migration)
-- We delete first to perform a clean update/insert on the view
DELETE FROM vault.decrypted_secrets WHERE name = 'cron_target_url';
INSERT INTO vault.decrypted_secrets (name, description, secret)
VALUES ('cron_target_url', 'Vercel API cron endpoint URL', 'https://pwusage.fm.rodeo/api/cron/restore-reserve');

-- Insert a placeholder for cron_secret if it doesn't exist yet
INSERT INTO vault.decrypted_secrets (name, description, secret)
SELECT 'cron_secret', 'Vercel cron endpoint authorization bearer token', 'placeholder-please-update-via-script'
WHERE NOT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'cron_secret');

-- Unschedule old cron trigger if it exists
SELECT cron.unschedule('restore-reserve-trigger');

-- Schedule the 15-minute HTTP check
SELECT cron.schedule(
  'restore-reserve-trigger',
  '*/15 * * * *',
  $$
  SELECT net.http_get(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_target_url' LIMIT 1),
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret' LIMIT 1)
    )
  );
  $$
);
