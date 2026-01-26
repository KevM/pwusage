-- Feature Branch Changes (verified against Dev DB)

-- User Table Updates
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS created_at BIGINT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS roles TEXT[];

-- LoadTag Table
CREATE TABLE IF NOT EXISTS "LoadTag" (
    id SERIAL PRIMARY KEY,
    site_id TEXT NOT NULL REFERENCES "Site"(id) ON DELETE CASCADE,
    start_time TIMESTAMP NOT NULL,
    end_time TIMESTAMP NOT NULL,
    tag TEXT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- SystemAnnouncement Table
CREATE TABLE IF NOT EXISTS "SystemAnnouncement" (
    id SERIAL PRIMARY KEY,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    author_id TEXT REFERENCES "User"(id)
    -- Note: Foreign key to User(id) is implied by column name author_id in dev dump, added explicit reference for safety
);

-- Security (RLS) and Permissions

-- Legacy Tables (Migrated from db-init.ts)
DO $$
DECLARE
    tables text[] := ARRAY['User', 'Site', 'Tariff', 'TariffSeason', 'TariffSchedule', 'EnergyData', 'TrmnlInstallation'];
    t text;
BEGIN
    FOREACH t IN ARRAY tables LOOP
        EXECUTE format('ALTER TABLE IF EXISTS %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('REVOKE ALL ON %I FROM PUBLIC', t);
        EXECUTE format('REVOKE ALL ON %I FROM anon', t);
        EXECUTE format('REVOKE ALL ON %I FROM authenticated', t);
        EXECUTE format('GRANT ALL ON %I TO service_role', t);
    END LOOP;
END $$;

-- LoadTag
ALTER TABLE "LoadTag" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "LoadTag" FROM PUBLIC;
REVOKE ALL ON "LoadTag" FROM anon;
REVOKE ALL ON "LoadTag" FROM authenticated;
GRANT ALL ON "LoadTag" TO "service_role";
GRANT ALL ON SEQUENCE "LoadTag_id_seq" TO "service_role";

-- SystemAnnouncement
ALTER TABLE "SystemAnnouncement" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "SystemAnnouncement" FROM PUBLIC;
REVOKE ALL ON "SystemAnnouncement" FROM anon;
REVOKE ALL ON "SystemAnnouncement" FROM authenticated;
GRANT ALL ON "SystemAnnouncement" TO "service_role";
GRANT ALL ON SEQUENCE "SystemAnnouncement_id_seq" TO "service_role";

-- Cleanup
DROP TABLE IF EXISTS "EnergyUsage";
