# Supabase Cron Trigger Implementation Plan

Replace the scheduled GitHub Actions workflow for battery reserve auto-restoration with a database-level scheduler using Supabase `pg_cron` and `pg_net` extensions, securing the endpoint secrets within Supabase Vault.

## User Review Required

> [!WARNING]
> This plan disables the existing GitHub Actions cron job. Once applied, the auto-restore triggers will run strictly from the database.
> The Vercel app domain and cron secret must be populated in the Supabase Vault (`vault.decrypted_secrets`) prior to deploying this to production, otherwise the HTTP requests will fail to authenticate or reach the API.

> [!IMPORTANT]
> The database migration requires superuser or appropriate schema privileges to enable the `pg_cron` and `pg_net` extensions and grant vault permissions.

## Proposed Changes

### Database Migrations

#### [NEW] [20260525020000_supabase_cron_trigger.sql](file:///Users/kevm/github/pwusage/.worktrees/tesla-backup-reserve/cmd/next-app/db-migrations/20260525020000_supabase_cron_trigger.sql)
Create SQL migration to:
1. Enable `pg_cron` and `pg_net` extensions.
2. Grant schema and table privileges to the connection role `postgres`.
3. Insert `cron_target_url` directly.
4. Insert placeholder Vault keys for `cron_secret`.
5. Schedule the 15-minute cron job to fetch Vault credentials and ping `/api/cron/restore-reserve`.

### Clean Up

#### [DELETE] [restore-reserve-cron.yml](file:///Users/kevm/github/pwusage/.worktrees/tesla-backup-reserve/.github/workflows/restore-reserve-cron.yml)
Delete the scheduled GitHub Actions workflow file to prevent duplicate runs.

---

## SQL Migration Draft

Create `cmd/next-app/db-migrations/20260525020000_supabase_cron_trigger.sql`:

```sql
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
```

---

## Verification Plan

### Manual Verification
1. **Apply Migration:** Apply the migration in the Supabase SQL Editor (or local development database).
2. **Configure Vault Keys:** Update the `cron_secret` value to match the target environment.
3. **Trigger Manually:** Run the cron job manually to verify it successfully hits Next.js:
   ```sql
   -- Run job immediately to test connection
   SELECT cron.alter_job(
     job_id := (SELECT jobid FROM cron.job WHERE jobname = 'restore-reserve-trigger'),
     schedule := '* * * * *' -- Run every minute for testing
   );
   ```
4. **Audit Execution Logs:** Check Supabase logs to verify successful 200 HTTP responses:
   ```sql
   SELECT * FROM cron.job_run_details 
   WHERE jobname = 'restore-reserve-trigger' 
   ORDER BY start_time DESC 
   LIMIT 5;
   ```
5. **Restore Schedule:** Restore the schedule to 15 minutes once verified:
   ```sql
   SELECT cron.alter_job(
     job_id := (SELECT jobid FROM cron.job WHERE jobname = 'restore-reserve-trigger'),
     schedule := '*/15 * * * *'
   );
   ```
