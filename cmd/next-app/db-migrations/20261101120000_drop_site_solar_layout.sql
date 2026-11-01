-- Migration: drop_site_solar_layout
-- Created at: 2026-11-01T12:00:00.000Z

-- Solar layout detection moved to the phone (docs/superpowers/plans/
-- 2026-10-30-on-device-solar-layout.md, Phase D). The home location and
-- detected layout now live on the user's devices and their private iCloud, so
-- the server drops the detection cron and the table that held them. Day
-- records keep serving history through /api/mobile/solar-history.
--
-- Idempotent: the unschedule is guarded by the job existing, and the drop by
-- IF EXISTS.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
       AND EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'detect-solar-layouts-trigger') THEN
        PERFORM cron.unschedule('detect-solar-layouts-trigger');
    END IF;
END $$;

DROP TABLE IF EXISTS "SiteSolarLayout";
