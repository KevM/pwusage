import type { EnergyData } from './db-types';
import type { UsageData } from './energy-repo';
import type { Schedule } from './schedule';

/** Each 15-minute bin holds the average of three 5-minute Wh samples. */
const SAMPLES_PER_BIN = 3;

/**
 * Today's net export per TOU period, in kWh, derived from the 15-minute bins
 * the live-data route already fetches for the sparklines.
 *
 * Each bin row supplies its actual sample count (b.sample_count), accurately
 * accounting for partial or TOU-boundary bins. The residual difference vs the
 * Live page is 15-minute bin resolution vs 5-minute raw samples.
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

        const name = tp.schedule.name || 'Standard';
        // grid_power is positive on import; negate for export-positive kWh.
        const samples = b.sample_count ?? SAMPLES_PER_BIN;
        const kwh = -(b.grid_power * samples) / 1000;
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
        .filter(u => (u.touName || 'Standard') === activePeriodName)
        .reduce((sum, u) => sum + -(u.gridUsage) / 1000, 0);

    return prior + (todayByPeriod.get(activePeriodName) ?? 0);
}
