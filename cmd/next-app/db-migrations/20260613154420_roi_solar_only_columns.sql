-- Migration: roi_solar_only_columns
-- Phase 2 ROI: plan-agnostic solar-only (no-battery) counterfactual flows. Idempotent.
ALTER TABLE "EnergyRollup" ADD COLUMN IF NOT EXISTS solar_only_import_wh DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "EnergyRollup" ADD COLUMN IF NOT EXISTS solar_only_export_wh DOUBLE PRECISION NOT NULL DEFAULT 0;
