-- Migration: urdb_estimates_cron
-- Created at: 2026-11-16T13:08:31.845Z

-- TODO: If this migration creates a new table, you MUST enable Row Level Security (RLS)!
-- ALTER TABLE "MyNewTable" ENABLE ROW LEVEL SECURITY;
-- REVOKE ALL ON "MyNewTable" FROM PUBLIC;
-- REVOKE ALL ON "MyNewTable" FROM anon;
-- REVOKE ALL ON "MyNewTable" FROM authenticated;
-- GRANT ALL ON "MyNewTable" TO service_role;
--
-- If using serial/sequence:
-- GRANT ALL ON SEQUENCE "MyNewTable_id_seq" TO service_role;

-- Run only when a non-orphaned site needs an estimate. The route limits each
-- invocation to five sites and 40 seconds; pg_net allows transport slack.
SELECT cron.schedule(
  'urdb-estimates-trigger',
  '*/10 * * * *',
  $$
  SELECT net.http_get(
    url := target.url,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret' LIMIT 1)
    ),
    timeout_milliseconds := 65000
  )
  FROM (
    SELECT regexp_replace(decrypted_secret, '/api/cron/restore-reserve$', '/api/cron/urdb-estimates') AS url
    FROM vault.decrypted_secrets WHERE name = 'battery_restore_cron_target_url' LIMIT 1
  ) target
  WHERE target.url LIKE 'https://%/api/cron/urdb-estimates'
    AND EXISTS (
      SELECT 1
      FROM public."Site" s
      LEFT JOIN public."SiteUtility" u ON u.site_id = s.id
      WHERE s.orphaned_at IS NULL
        AND (u.site_id IS NULL
          OR u.status = 'pending'
          OR (u.status = 'running' AND u.updated_at < now() - interval '5 minutes')
          OR (u.status IN ('ready', 'needs_utility', 'needs_plan', 'failed') AND u.next_check_at <= now()))
    );
  $$
);
