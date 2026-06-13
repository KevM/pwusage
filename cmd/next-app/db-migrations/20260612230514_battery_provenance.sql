-- Migration: battery_provenance
-- Created at: 2026-06-12T23:05:14Z

-- Battery power provenance + per-tariff-period energy rollups.
-- Idempotent (safe to re-run).

-- 1. Persist Tesla's per-interval battery charge source (Wh). Nullable:
--    historical rows we cannot re-fetch fall back to sankey-derived split.
ALTER TABLE "EnergyData" ADD COLUMN IF NOT EXISTS battery_charge_from_solar DOUBLE PRECISION;
ALTER TABLE "EnergyData" ADD COLUMN IF NOT EXISTS battery_charge_from_grid DOUBLE PRECISION;

-- 2. One row per (site, local calendar date, tariff period).
CREATE TABLE IF NOT EXISTS "EnergyRollup" (
    site_id            TEXT    NOT NULL,
    local_date         DATE    NOT NULL,
    tariff_schedule_id INTEGER NOT NULL,

    -- Period energy flows (Wh).
    load_wh             DOUBLE PRECISION NOT NULL DEFAULT 0,
    solar_to_home_wh    DOUBLE PRECISION NOT NULL DEFAULT 0,
    solar_to_battery_wh DOUBLE PRECISION NOT NULL DEFAULT 0,
    solar_to_grid_wh    DOUBLE PRECISION NOT NULL DEFAULT 0,
    grid_to_home_wh     DOUBLE PRECISION NOT NULL DEFAULT 0,
    grid_to_battery_wh  DOUBLE PRECISION NOT NULL DEFAULT 0,
    battery_to_home_wh  DOUBLE PRECISION NOT NULL DEFAULT 0,
    battery_to_grid_wh  DOUBLE PRECISION NOT NULL DEFAULT 0,

    -- End-of-period tank state (path-dependent carry-forward seed).
    tank_solar_wh   DOUBLE PRECISION NOT NULL DEFAULT 0,
    tank_grid_wh    DOUBLE PRECISION NOT NULL DEFAULT 0,
    tank_solar_cost DOUBLE PRECISION NOT NULL DEFAULT 0,
    tank_grid_cost  DOUBLE PRECISION NOT NULL DEFAULT 0,
    tank_as_of      TIMESTAMPTZ NOT NULL,

    -- Snapshot fields: resolved rates frozen at rollup time (no join needed),
    -- and end-of-period SOC.
    buy_rate    DOUBLE PRECISION NOT NULL DEFAULT 0,
    sell_rate   DOUBLE PRECISION NOT NULL DEFAULT 0,
    battery_soc DOUBLE PRECISION,

    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (site_id, local_date, tariff_schedule_id)
);

-- Range reads for a site.
CREATE INDEX IF NOT EXISTS idx_energyrollup_site_date
    ON "EnergyRollup" (site_id, local_date);

-- Carry-forward seed lookup: row with greatest tank_as_of before a given instant.
CREATE INDEX IF NOT EXISTS idx_energyrollup_seed
    ON "EnergyRollup" (site_id, tank_as_of);
