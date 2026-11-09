-- Migration: site_billing_start_day_confirmed
-- Created at: 2026-11-09T12:00:00.000Z

-- When a person chose the site's billing day (web setup, web settings or iOS).
-- billing_start_day defaults to 1, so a stored 1 cannot say whether anyone was
-- ever asked; this marker can. Sites whose day is not 1 were necessarily chosen,
-- so they are backfilled as confirmed. Sites at 1 stay unconfirmed and get one
-- "Is this right?" prompt in the iOS app. Additive and idempotent.
ALTER TABLE "Site" ADD COLUMN IF NOT EXISTS billing_start_day_confirmed_at timestamptz;

UPDATE "Site"
SET billing_start_day_confirmed_at = now()
WHERE billing_start_day_confirmed_at IS NULL
  AND billing_start_day IS NOT NULL
  AND billing_start_day <> 1;
