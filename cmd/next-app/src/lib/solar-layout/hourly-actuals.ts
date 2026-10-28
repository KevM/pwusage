// Recent hourly solar production for the phone's forecast correction
// (actual / forecast energy per local hour over the trailing 14 days).
import { Temporal } from '@js-temporal/polyfill';

export const SOLAR_ACTUALS_DAYS = 14;
const HOUR_MS = 3_600_000;

/** UTC interval-start buckets. Incomplete hours sum only valid, unambiguous aligned slots;
 * correction consumers must ignore incomplete hours. */
export function hourlySolarWh(rows: { timestamp: Date; solar_power: number }[]): { hourStart: string; wh: number; complete: boolean }[] {
    const buckets = new Map<number, { slots: Map<number, number | null>; invalid: boolean }>();
    for (const row of rows) {
        const t = row.timestamp.getTime();
        if (!Number.isFinite(t)) throw new Error('Invalid solar actual timestamp');
        const hour = Math.floor(t / HOUR_MS) * HOUR_MS;
        let bucket = buckets.get(hour);
        if (!bucket) buckets.set(hour, (bucket = { slots: new Map(), invalid: false }));
        if (t % 300_000 !== 0) { bucket.invalid = true; continue; }
        const value = Number(row.solar_power);
        if (!Number.isFinite(value) || value < 0) {
            bucket.invalid = true;
            bucket.slots.set(t, null);
            continue;
        }
        if (!bucket.slots.has(t)) bucket.slots.set(t, value);
        else if (bucket.slots.get(t) !== value) bucket.slots.set(t, null);
    }
    return [...buckets.entries()].sort(([a], [b]) => a - b).map(([hour, bucket]) => {
        let wh = 0;
        let valid = 0;
        for (const value of bucket.slots.values()) if (value !== null) { wh += value; valid++; }
        return { hourStart: new Date(hour).toISOString(), wh: Math.round(wh * 10) / 10, complete: !bucket.invalid && valid === 12 };
    });
}

/** The 14 full site-local days before today plus today so far. */
export function solarActualsWindow(now: Date, timeZone: string): { start: Date; end: Date } {
    const today = Temporal.Instant.fromEpochMilliseconds(now.getTime()).toZonedDateTimeISO(timeZone).toPlainDate();
    const start = today.subtract({ days: SOLAR_ACTUALS_DAYS }).toZonedDateTime({ timeZone }).epochMilliseconds;
    return { start: new Date(start), end: now };
}
