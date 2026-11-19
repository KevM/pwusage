-- Migration: verify_pending_trmnl_plugin_id
-- Created at: 2026-11-19T01:41:02.000Z

ALTER TABLE "TrmnlInstallation"
    ADD COLUMN IF NOT EXISTS plugin_setting_id_verified BOOLEAN NOT NULL DEFAULT false;

-- Clear unverified browser-supplied plugin_setting_id values on existing pending rows
-- so signed webhooks cannot claim a pending installation created under the old behavior.
UPDATE "TrmnlInstallation"
SET plugin_setting_id = NULL
WHERE uuid IS NULL
  AND plugin_setting_id IS NOT NULL
  AND plugin_setting_id_verified = false;
