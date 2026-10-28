// Recent hourly solar production for the phone's forecast correction
// (actual / forecast energy per local hour over the trailing 14 days).
import { Temporal } from '@js-temporal/polyfill';

export const SOLAR_ACTUALS_DAYS = 14;
const HOUR_MS = 3_600_000;

/** UTC hour buckets by interval start; `complete` when all 12 five-minute samples exist. */
export function hourlySolarWh(rows: { timestamp: Date; solar_power: number }[]): { hourStart: string; wh: number; complete: boolean }[] {
    const buckets = new Map<number, Map<number, number>>();
    for (const row of rows) {
        const t = row.timestamp.getTime();
        const hour = Math.floor(t / HOUR_MS) * HOUR_MS;
        let samples = buckets.get(hour);
        if (!samples) buckets.set(hour, (samples = new Map()));
        if (!samples.has(t)) samples.set(t, Number(row.solar_power) || 0);
    }
    return [...buckets.entries()].sort(([a], [b]) => a - b).map(([hour, samples]) => {
        let wh = 0;
        for (const v of samples.values()) wh += v;
        return { hourStart: new Date(hour).toISOString(), wh: Math.round(wh * 10) / 10, complete: samples.size === 12 };
    });
}

/** The 14 full site-local days before today plus today so far. */
export function solarActualsWindow(now: Date, timeZone: string): { start: Date; end: Date } {
    const today = Temporal.Instant.fromEpochMilliseconds(now.getTime()).toZonedDateTimeISO(timeZone).toPlainDate();
    const start = today.subtract({ days: SOLAR_ACTUALS_DAYS }).toZonedDateTime({ timeZone }).epochMilliseconds;
    return { start: new Date(start), end: now };
}
