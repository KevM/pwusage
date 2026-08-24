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
 * The slice of today the caller's already-fetched window misses.
 *
 * The live route reuses the rolling 24-hour sparkline rows for today's
 * contribution, which normally covers site-local midnight. On a DST fallback
 * day the local day runs 25 hours, so late in the evening midnight is more
 * than 24 hours back and the head of the day falls outside that window.
 * Returns null on every ordinary day, so the extra query is paid at most a
 * few hours a year.
 */
export function missingTodayInterval(
    siteMidnight: Date,
    fetchedStart: Date
): { start: Date; end: Date } | null {
    if (siteMidnight >= fetchedStart) return null;
    return { start: siteMidnight, end: fetchedStart };
}

/**
 * Cycle-to-date surplus for one TOU period: the cached rollup of completed
 * days plus today's contribution. Negative means the period is in deficit.
 *
 * Returns null when neither source holds a single row — an absence of
 * measurements is not a confirmed zero surplus, and callers must render it as
 * unknown rather than as "avoid large loads".
 */
export function activePeriodSurplusKwh(
    priorCycle: UsageData[],
    todayByPeriod: Map<string, number>,
    activePeriodName: string
): number | null {
    if (priorCycle.length === 0 && todayByPeriod.size === 0) return null;

    const prior = priorCycle
        .filter(u => (u.touName || 'Standard') === activePeriodName)
        .reduce((sum, u) => sum + -(u.gridUsage) / 1000, 0);

    return prior + (todayByPeriod.get(activePeriodName) ?? 0);
}
