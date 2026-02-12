-- Remove is_synthetic column from EnergyData table
-- Synthetic records are no longer used; installation date clamping and 
-- future timestamp filtering provide the same functionality

ALTER TABLE "EnergyData" DROP COLUMN IF EXISTS is_synthetic;
