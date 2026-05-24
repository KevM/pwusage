-- Append-only tariff versioning.
-- Root cause being fixed: TariffRepo.replaceTariffsForSite deleted Tariff rows on
-- every tariff-content change. That DELETE cascade-wiped EnergyData (via
-- EnergyData_tariff_id_fkey ON DELETE CASCADE) and orphaned the importer's
-- in-memory tariff snapshot (FK violation, worked around by remapTariffIds).
-- After this change tariffs are append-only: a new version is inserted and the
-- old one is demoted (is_current=false), never deleted.
-- See docs/superpowers/specs/2026-05-24-tariff-versioning-design.md
-- Uses unique INDEXES (not table constraints) so the migration is idempotent
-- (ADD CONSTRAINT has no IF NOT EXISTS); ON CONFLICT can infer a unique index.

-- 1. Tariff: versioning columns.
ALTER TABLE "Tariff" ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Tariff" ADD COLUMN IF NOT EXISTS is_current BOOLEAN NOT NULL DEFAULT true;
-- content_hash: deterministic hash of the parsed tariff; lets addTariffVersion
-- skip appending a new version when content is unchanged.
ALTER TABLE "Tariff" ADD COLUMN IF NOT EXISTS content_hash TEXT;

-- Enforce non-null name: the partial unique index below relies on it to guarantee
-- one current version per (site_id, name). Verified safe: 0 NULL-named tariffs in prod.
ALTER TABLE "Tariff" ALTER COLUMN name SET NOT NULL;

-- 2. Replace UNIQUE(site_id, name) with version-aware uniqueness + one-current guard.
ALTER TABLE "Tariff" DROP CONSTRAINT IF EXISTS "Tariff_site_id_name_key";
CREATE UNIQUE INDEX IF NOT EXISTS tariff_site_name_version_uidx
    ON "Tariff"(site_id, name, version);
-- Partial index: at most one current version per named tariff. Also doubles as
-- the access path for the SiteRepo read join (t.site_id = s.id AND t.is_current).
CREATE UNIQUE INDEX IF NOT EXISTS tariff_current_uidx
    ON "Tariff"(site_id, name) WHERE is_current;

-- 3. Tighten EnergyData identity to one reading per instant per site.
-- Validated 2026-05-24 against production: 0 (timestamp, site_id) pairs reference
-- more than one tariff_id, so this is a safe, non-lossy swap. tariff_id is
-- retained (still NOT NULL, still used by billing); only the unique key changes.
ALTER TABLE "EnergyData" DROP CONSTRAINT IF EXISTS "EnergyData_timestamp_site_id_tariff_id_key";
CREATE UNIQUE INDEX IF NOT EXISTS energy_ts_site_uidx
    ON "EnergyData"(timestamp, site_id);
