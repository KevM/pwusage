-- Add cancelled_observed_reserve column to BatteryHold table to persist observed reserve at cancel time.
ALTER TABLE "BatteryHold" ADD COLUMN IF NOT EXISTS cancelled_observed_reserve INTEGER;
