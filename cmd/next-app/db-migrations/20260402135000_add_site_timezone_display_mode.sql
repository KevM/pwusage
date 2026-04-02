ALTER TABLE "Site"
ADD COLUMN IF NOT EXISTS timezone_display_mode TEXT;

UPDATE "Site"
SET timezone_display_mode = 'SITE'
WHERE timezone_display_mode IS NULL;

ALTER TABLE "Site"
ALTER COLUMN timezone_display_mode SET DEFAULT 'SITE';

ALTER TABLE "Site"
ALTER COLUMN timezone_display_mode SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'site_timezone_display_mode_check'
    ) THEN
        ALTER TABLE "Site"
        ADD CONSTRAINT site_timezone_display_mode_check
        CHECK (timezone_display_mode IN ('SITE', 'BROWSER'));
    END IF;
END $$;
