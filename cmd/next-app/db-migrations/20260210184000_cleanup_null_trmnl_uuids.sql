-- Remove TrmnlInstallation records that have no UUID
-- These are usually trash or incomplete records that cause issues during restore operations.
DELETE FROM "TrmnlInstallation" WHERE uuid IS NULL;
