-- Add performance index for Trmnl dashboard and Importer coverage checks
CREATE INDEX IF NOT EXISTS idx_energy_site_ts ON "EnergyData"(site_id, timestamp);
