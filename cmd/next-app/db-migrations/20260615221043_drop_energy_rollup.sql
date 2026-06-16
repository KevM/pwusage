-- Retire EnergyRollup: the per-tariff-period daily aggregate is superseded by the
-- plan-agnostic EnergyHourly profile (Phase B), with pricing AND battery provenance
-- now computed on read (Phase C). Raw 5-min EnergyData is retained forever, so this
-- aggregate is fully recomputable if ever needed. Idempotent.
DROP TABLE IF EXISTS "EnergyRollup";
