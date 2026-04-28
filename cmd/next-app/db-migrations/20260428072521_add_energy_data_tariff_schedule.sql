-- Add tariff_schedule_id to EnergyData for cycle aggregation queries.
-- Nullable: historical rows are unstamped until backfill runs; getTariffPeriod
-- can also legitimately return null when no schedule matches a timestamp.
-- ON DELETE SET NULL: TariffSchedule rows are deleted/recreated by tariff
-- re-imports, so existing EnergyData rows must survive that.

ALTER TABLE "EnergyData"
  ADD COLUMN IF NOT EXISTS tariff_schedule_id INTEGER
  REFERENCES "TariffSchedule"(id) ON DELETE SET NULL;
