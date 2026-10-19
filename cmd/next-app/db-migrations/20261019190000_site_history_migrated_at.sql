-- Migration: site_history_migrated_at
-- Created at: 2026-10-19T19:00:00.000Z
-- When scripts/migrate-site-history.ts last completed a full --apply run for
-- the site (backfill to install + every archivable day archived). Shown on the
-- admin Sites tab. NULL = not migrated.

ALTER TABLE "Site" ADD COLUMN IF NOT EXISTS history_migrated_at TIMESTAMPTZ;
