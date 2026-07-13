-- Migration: repair_x1000_scaled_energy_rows
-- Created at: 2026-07-13T01:55:48.928Z

-- Repair EnergyData rows that the importer multiplied by 1000 after
-- misclassifying lone 5-minute Wh samples as whole-day kWh aggregates
-- (fixed for short windows by the 2026-04-27 requestedDurationHours guard;
-- the scaling itself is removed entirely in this PR).
--
-- Audit (2026-07-12): 85 affected rows, 2026-02-19 .. 2026-04-27, all at
-- site-local midnight. Every affected row has a field > 20 kWh, and no
-- legitimate row anywhere sits in the 5-20 kWh band, so the threshold
-- separates poison from real data with zero collateral. A real 5-minute
-- sample cannot exceed 20 kWh (that is 240 kW sustained). All four energy
-- fields of an affected row were scaled together, so dividing by 1000
-- restores the original values exactly (battery_soc was never scaled).
--
-- Idempotent: after one pass no affected field exceeds the threshold
-- (max observed post-repair value ~1,068 Wh), so a re-run matches nothing.
UPDATE "EnergyData"
SET load_power    = load_power / 1000,
    solar_power   = solar_power / 1000,
    grid_power    = grid_power / 1000,
    battery_power = battery_power / 1000
WHERE timestamp < '2026-04-28T00:00:00Z'
  AND (load_power > 20000
       OR solar_power > 20000
       OR ABS(grid_power) > 20000
       OR ABS(battery_power) > 20000);
