-- Migration: site_utility_reference_label
-- Created at: 2026-11-22T23:55:53.913Z

-- TODO: If this migration creates a new table, you MUST enable Row Level Security (RLS)!
-- ALTER TABLE "MyNewTable" ENABLE ROW LEVEL SECURITY;
-- REVOKE ALL ON "MyNewTable" FROM PUBLIC;
-- REVOKE ALL ON "MyNewTable" FROM anon;
-- REVOKE ALL ON "MyNewTable" FROM authenticated;
-- GRANT ALL ON "MyNewTable" TO service_role;
--
-- If using serial/sequence:
-- GRANT ALL ON SEQUENCE "MyNewTable_id_seq" TO service_role;

-- The utility fixed plan the owner chose as their comparison, and the day the choice starts.
-- Both set or both null; the estimate job lays new revisions of that label from that day.
ALTER TABLE "SiteUtility" ADD COLUMN IF NOT EXISTS urdb_reference_label text;
ALTER TABLE "SiteUtility" ADD COLUMN IF NOT EXISTS urdb_reference_from date;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'site_utility_reference_label_pair'
          AND conrelid = '"SiteUtility"'::regclass
    ) THEN
        ALTER TABLE "SiteUtility" ADD CONSTRAINT site_utility_reference_label_pair
            CHECK ((urdb_reference_label IS NULL) = (urdb_reference_from IS NULL));
    END IF;
END $$;
