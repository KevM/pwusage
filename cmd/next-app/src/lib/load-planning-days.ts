import { Temporal } from '@js-temporal/polyfill';
import type { EnergyData } from './db-types';

export const INTERVAL_MINUTES = 5;
export const HALF_HOUR_MINUTES = 30;
export const MINIMUM_COVERAGE = 0.9;
/** How far a stored timestamp may sit from the expected interval it belongs to. */
const TIMESTAMP_TOLERANCE_MS = 60_000;

export interface AlignedDay {
    timestamps: Date[];
    slots: Map<number, Date[]>;
}

export interface AlignedHistory {
    /** Complete local days with at least 90% interval coverage, oldest first. */
    days: AlignedDay[];
    rowsByTimestamp: Map<number, EnergyData>;
    candidateRows: number;
    unalignedRows: number;
    historyStart: Date;
    historyEnd: Date;
}

function localMinute(instant: Date, timeZone: string): number {
    const local = Temporal.Instant.from(instant.toISOString()).toZonedDateTimeISO(timeZone);
    return local.hour * 60 + local.minute;
}

/**
 * Lay out the `days` complete local days before `asOf` as five-minute
 * intervals grouped into local half-hour slots, attach each stored row to its
 * nearest interval, and keep the days with at least 90% interval coverage.
 * On fall-back days both occurrences of a repeated hour share one slot;
 * nonexistent spring-forward slots are absent.
 */
export function alignHistoryDays(
    rows: EnergyData[],
    timeZone: string,
    asOf: Date,
    days: number
): AlignedHistory {
    const historyEndDate = Temporal.Instant.from(asOf.toISOString()).toZonedDateTimeISO(timeZone).toPlainDate();
    const historyStartDate = historyEndDate.subtract({ days });
    const historyStart = new Date(historyStartDate.toZonedDateTime({ timeZone }).epochMilliseconds);
    const historyEnd = new Date(historyEndDate.toZonedDateTime({ timeZone }).epochMilliseconds);

    const expectedDays: AlignedDay[] = [];
    for (let dayOffset = 0; dayOffset < days; dayOffset += 1) {
        const localDate = historyStartDate.add({ days: dayOffset });
        // Resolve each date's start independently. Adding one calendar day to
        // a zoned midnight can preserve 01:00 after a midnight DST gap.
        const day = localDate.toZonedDateTime({ timeZone });
        const nextDay = localDate.add({ days: 1 }).toZonedDateTime({ timeZone });
        const timestamps: Date[] = [];
        const slots = new Map<number, Date[]>();
        for (let instant = day; Temporal.ZonedDateTime.compare(instant, nextDay) < 0; instant = instant.add({ minutes: INTERVAL_MINUTES })) {
            const timestamp = new Date(instant.epochMilliseconds);
            timestamps.push(timestamp);
            const minute = localMinute(timestamp, timeZone);
            const slot = Math.floor(minute / HALF_HOUR_MINUTES) * HALF_HOUR_MINUTES;
            const slotTimestamps = slots.get(slot) ?? [];
            slotTimestamps.push(timestamp);
            slots.set(slot, slotTimestamps);
        }
        expectedDays.push({
            timestamps,
            slots,
        });
    }

    const rowsByTimestamp = new Map<number, EnergyData>();
    // Stored timestamps are not guaranteed to land exactly on the site-local grid
    // (rounding, sub-minute importer values, provider changes). Attach each row to
    // the nearest expected interval within a tolerance instead of dropping the day,
    // claiming each interval at most once so no interval is double-counted.
    const grid = expectedDays.flatMap((day) => day.timestamps).map((timestamp) => timestamp.getTime());
    const claimed = new Set<number>();
    let candidateRows = 0;
    let unalignedRows = 0;
    for (const row of rows) {
        const time = row.timestamp.getTime();
        if (!Number.isFinite(time)
            || !Number.isFinite(row.load_power)
            || !Number.isFinite(row.battery_power)
            || time < historyStart.getTime()
            || time >= historyEnd.getTime()) {
            continue;
        }
        candidateRows += 1;
        let low = 0;
        let high = grid.length - 1;
        let insertion = -1;
        while (low <= high) {
            const middle = (low + high) >> 1;
            if (grid[middle] < time) {
                low = middle + 1;
            } else {
                insertion = middle;
                high = middle - 1;
            }
        }
        // The nearest interval may sit on either side of the insertion point.
        let best = -1;
        for (const candidate of [insertion - 1, insertion]) {
            if (candidate < 0 || candidate >= grid.length) continue;
            if (best < 0 || Math.abs(grid[candidate] - time) < Math.abs(grid[best] - time)) {
                best = candidate;
            }
        }
        if (best < 0 || Math.abs(grid[best] - time) > TIMESTAMP_TOLERANCE_MS || claimed.has(best)) {
            unalignedRows += 1;
            continue;
        }
        claimed.add(best);
        rowsByTimestamp.set(grid[best], row);
    }

    const usableDays = expectedDays.filter((day) => {
        const observed = day.timestamps.reduce((count, timestamp) => count + (rowsByTimestamp.has(timestamp.getTime()) ? 1 : 0), 0);
        return observed / day.timestamps.length >= MINIMUM_COVERAGE;
    });

    return { days: usableDays, rowsByTimestamp, candidateRows, unalignedRows, historyStart, historyEnd };
}

/**
 * The rows observed in one day's half-hour slot, or null when the slot does
 * not exist that day (spring-forward) or has under 90% interval coverage.
 */
export function observedSlotRows(
    day: AlignedDay,
    minute: number,
    rowsByTimestamp: Map<number, EnergyData>,
    isUsable: (row: EnergyData) => boolean
): { possible: boolean; rows: EnergyData[] | null } {
    const expected = day.slots.get(minute);
    if (!expected?.length) return { possible: false, rows: null };
    const observedRows = expected
        .map((timestamp) => rowsByTimestamp.get(timestamp.getTime()))
        .filter((row): row is EnergyData => row !== undefined && isUsable(row));
    if (observedRows.length / expected.length < MINIMUM_COVERAGE) return { possible: true, rows: null };
    return { possible: true, rows: observedRows };
}

/**
 * Average kW over observed rows. Every observation represents five minutes;
 * divide integrated Wh by observed hours to get the average power.
 */
export function averageKw(rows: EnergyData[], valueWh: (row: EnergyData) => number): number {
    const observedHours = rows.length * INTERVAL_MINUTES / 60;
    return rows.reduce((sum, row) => sum + valueWh(row), 0) / 1000 / observedHours;
}
