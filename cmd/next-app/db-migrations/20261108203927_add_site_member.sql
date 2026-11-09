-- A pwusage site is a home. Each Tesla account can have a different current
-- energy_site_id for that home, including after a re-invitation.
CREATE TABLE IF NOT EXISTS "SiteMember" (
    site_id TEXT NOT NULL REFERENCES "Site"(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
    tesla_energy_site_id TEXT NOT NULL UNIQUE,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_in_tesla_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    commands_denied_at TIMESTAMPTZ,
    PRIMARY KEY (site_id, user_id)
);
CREATE INDEX IF NOT EXISTS "SiteMember_user_id_idx" ON "SiteMember"(user_id);
ALTER TABLE "SiteMember" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "SiteMember" FROM PUBLIC;
REVOKE ALL ON "SiteMember" FROM anon;
REVOKE ALL ON "SiteMember" FROM authenticated;
GRANT ALL ON "SiteMember" TO service_role;

ALTER TABLE "Site"
    ADD COLUMN IF NOT EXISTS tesla_hardware_id TEXT,
    ADD COLUMN IF NOT EXISTS tesla_connection_user_id TEXT,
    ADD COLUMN IF NOT EXISTS connection_lost_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS connection_restored_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS "Site_tesla_hardware_id_idx" ON "Site"(tesla_hardware_id);
UPDATE "Site" SET tesla_hardware_id = json ->> 'id'
WHERE tesla_hardware_id IS NULL;
INSERT INTO "SiteMember" (site_id, user_id, tesla_energy_site_id)
SELECT id, user_id, id FROM "Site" WHERE user_id IS NOT NULL
ON CONFLICT DO NOTHING;
UPDATE "Site" SET tesla_connection_user_id = user_id
WHERE user_id IS NOT NULL AND tesla_connection_user_id IS NULL;

-- The connection may point only to a member. A departing member clears it.
ALTER TABLE "Site" DROP CONSTRAINT IF EXISTS "Site_tesla_connection_member_fkey";
ALTER TABLE "Site" ADD CONSTRAINT "Site_tesla_connection_member_fkey"
    FOREIGN KEY (id, tesla_connection_user_id)
    REFERENCES "SiteMember"(site_id, user_id)
    ON DELETE SET NULL (tesla_connection_user_id);
ALTER TABLE "Site" DROP CONSTRAINT IF EXISTS "Site_user_id_fkey";
ALTER TABLE "Site" ADD CONSTRAINT "Site_user_id_fkey"
    FOREIGN KEY (user_id) REFERENCES "User"(id) ON DELETE SET NULL;

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS memberships_checked_at TIMESTAMPTZ;
ALTER TABLE "BatteryHold" ADD COLUMN IF NOT EXISTS started_by_user_id TEXT
    REFERENCES "User"(id) ON DELETE SET NULL;
ALTER TABLE "TrmnlInstallation" ADD COLUMN IF NOT EXISTS installed_by_user_id TEXT
    REFERENCES "User"(id) ON DELETE SET NULL;
UPDATE "TrmnlInstallation" t SET installed_by_user_id = s.user_id
FROM "Site" s WHERE s.id = t.site_id AND t.installed_by_user_id IS NULL;

-- This lease spans the Tesla reserve read, command, and hold insert, including
-- across duplicate site rows for one physical Powerwall.
CREATE TABLE IF NOT EXISTS "BatteryHoldStartClaim" (
    claim_key TEXT PRIMARY KEY,
    owner UUID NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL
);
ALTER TABLE "BatteryHoldStartClaim" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "BatteryHoldStartClaim" FROM PUBLIC;
REVOKE ALL ON "BatteryHoldStartClaim" FROM anon;
REVOKE ALL ON "BatteryHoldStartClaim" FROM authenticated;
GRANT ALL ON "BatteryHoldStartClaim" TO service_role;
