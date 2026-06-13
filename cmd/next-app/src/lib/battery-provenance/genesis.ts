import type { EnergyData } from '../db';
import { Schedule } from '../schedule';
import { resolveRates } from './rates';
import { chargeTank, EMPTY_TANK, type Tank } from './tank';

export interface GenesisSeed {
    seed: Tank;
    anchorTimestamp: Date; // timestamp of the first full-SOC row
}

/**
 * Find the first interval where battery_soc >= fullThreshold and seed the tank
 * from the contiguous run of charging intervals (battery_power > 0) ending at it.
 * The charge split prefers Tesla's measured values, else assumes grid (conservative).
 */
export function computeGenesisSeed(
    rows: EnergyData[],
    schedule: Schedule,
    timeZone: string,
    fullThreshold = 98,
): GenesisSeed | null {
    const ordered = [...rows].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    const anchorIndex = ordered.findIndex(r => r.battery_soc != null && r.battery_soc >= fullThreshold);
    if (anchorIndex === -1) return null;

    let tank: Tank = EMPTY_TANK;
    // Walk backward over contiguous charging intervals (inclusive of the anchor).
    let i = anchorIndex;
    while (i >= 0 && ordered[i].battery_power > 0) i--;
    for (let j = i + 1; j <= anchorIndex; j++) {
        const r = ordered[j];
        const period = schedule.getTariffPeriod(r.timestamp);
        if (!period) continue;
        const { buyRate, sellRate } = resolveRates(period);
        const solarWh = r.battery_charge_from_solar ?? 0;
        const gridWh = r.battery_charge_from_grid ?? Math.max(r.battery_power - solarWh, 0);
        tank = chargeTank(tank, solarWh, gridWh, buyRate, sellRate);
    }
    return { seed: tank, anchorTimestamp: ordered[anchorIndex].timestamp };
}
