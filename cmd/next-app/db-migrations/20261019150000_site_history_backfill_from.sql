-- Migration: site_history_backfill_from
-- Created at: 2026-10-19T15:00:00.000Z
-- First site-local day worth backfilling from Tesla. Site.installed is the
-- hardware install date; the days before the utility provisions the site have
-- no data, so history backfill records where real data starts and stops
-- re-fetching that gap. NULL = not yet known (backfill starts at installed).

ALTER TABLE "Site" ADD COLUMN IF NOT EXISTS history_backfill_from TIMESTAMPTZ;
