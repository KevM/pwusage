-- Add updated_at to SystemAnnouncement and ensure timestamps use TIMESTAMPTZ
-- This preserves the original posted date (created_at) while tracking edits.

ALTER TABLE "SystemAnnouncement" 
    ALTER COLUMN created_at TYPE TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

-- Initialize updated_at with created_at for existing records
UPDATE "SystemAnnouncement" 
SET updated_at = created_at 
WHERE updated_at IS NULL;
