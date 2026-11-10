-- Migration: add_site_orphaned_at
-- Created at: 2026-11-10T16:46:00.115Z

-- TODO: If this migration creates a new table, you MUST enable Row Level Security (RLS)!
-- ALTER TABLE "MyNewTable" ENABLE ROW LEVEL SECURITY;
-- REVOKE ALL ON "MyNewTable" FROM PUBLIC;
-- REVOKE ALL ON "MyNewTable" FROM anon;
-- REVOKE ALL ON "MyNewTable" FROM authenticated;
-- GRANT ALL ON "MyNewTable" TO service_role;
--
-- If using serial/sequence:
-- GRANT ALL ON SEQUENCE "MyNewTable_id_seq" TO service_role;

-- Tracks when a Site loses its last member so reconcileDueMemberships can purge
-- orphaned sites and their archives after 30 days.
ALTER TABLE "Site"
    ADD COLUMN IF NOT EXISTS orphaned_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS "Site_orphaned_at_idx"
    ON "Site"(orphaned_at)
    WHERE orphaned_at IS NOT NULL;

-- Backfill existing memberless sites so their 30-day retention window starts now.
UPDATE "Site" s
SET orphaned_at = now(),
    tesla_hardware_id = CASE
        WHEN s.tesla_hardware_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM "Site" other
            JOIN "SiteMember" m ON m.site_id = other.id
            WHERE other.id <> s.id AND other.tesla_hardware_id = s.tesla_hardware_id
        ) THEN NULL
        ELSE s.tesla_hardware_id
    END
WHERE s.orphaned_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM "SiteMember" m WHERE m.site_id = s.id);
