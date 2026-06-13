-- Migration: site_roi_config
-- Phase 2 ROI: per-site capital costs + the flat comparison plan. Idempotent.
CREATE TABLE IF NOT EXISTS "SiteRoiConfig" (
    site_id              TEXT PRIMARY KEY REFERENCES "Site"(id) ON DELETE CASCADE,
    solar_cost           DOUBLE PRECISION,
    solar_install_date   DATE,
    battery_cost         DOUBLE PRECISION,
    battery_install_date DATE,
    fixed_buy_rate       DOUBLE PRECISION,
    fixed_sell_rate      DOUBLE PRECISION,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
