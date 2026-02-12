-- Migrate all TIMESTAMP columns to TIMESTAMPTZ
-- This ensures that all dates are stored as unambiguous UTC values
-- and that the pg driver returns them as correct JS Date objects.

ALTER TABLE "Site" 
    ALTER COLUMN updated TYPE TIMESTAMPTZ,
    ALTER COLUMN installed TYPE TIMESTAMPTZ;

ALTER TABLE "EnergyData" 
    ALTER COLUMN timestamp TYPE TIMESTAMPTZ;

ALTER TABLE "TrmnlInstallation" 
    ALTER COLUMN created_at TYPE TIMESTAMPTZ;
