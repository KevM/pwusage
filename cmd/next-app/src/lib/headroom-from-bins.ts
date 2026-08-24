import type { EnergyData } from './db-types';
import type { UsageData } from './energy-repo';
import type { Schedule } from './schedule';

/** Each 15-minute bin holds the average of three 5-minute Wh samples. */
const SAMPLES_PER_BIN = 3;

/**
 * Today's net export per TOU period, in kWh, derived from the 15-minute bins
 * the live-data route already fetches for the sparklines.
 *
 * Deliberately approximate: a partial bin (the in-progress one, or one missing
 * samples) is scaled as if it were full, so the result can run slightly high.
 * This value only ever selects a header glyph — the Live page runs the exact
 * computation. See the design doc's "Egress and precision".
 */
export function todayNetExportByPeriod(
    bins: EnergyData[],
    siteMidnight: Date,
    schedule: Schedule
): Map<string, number> {
    const byPeriod = new Map<string, number>();

    for (const b of bins) {
        if (b.timestamp < siteMidnight) continue;

        const tp = schedule.getTariffPeriod(b.timestamp);
        if (!tp) continue;

        const name = tp.schedule.name ?? 'Unknown';
        // grid_power is positive on import; negate for export-positive kWh.
        const kwh = -(b.grid_power * SAMPLES_PER_BIN) / 1000;
        byPeriod.set(name, (byPeriod.get(name) ?? 0) + kwh);
    }

    return byPeriod;
}

/**
 * Cycle-to-date surplus for one TOU period: the cached rollup of completed
 * days plus today's contribution. Negative means the period is in deficit.
 */
export function activePeriodSurplusKwh(
    priorCycle: UsageData[],
    todayByPeriod: Map<string, number>,
    activePeriodName: string
): number {
    const prior = priorCycle
        .filter(u => (u.touName ?? 'Unknown') === activePeriodName)
        .reduce((sum, u) => sum + -(u.gridUsage) / 1000, 0);

    return prior + (todayByPeriod.get(activePeriodName) ?? 0);
}
