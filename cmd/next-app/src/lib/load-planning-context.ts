import { Temporal } from '@js-temporal/polyfill';
import type { EnergyData } from './db-types';

const INTERVAL_MINUTES = 5;
const HALF_HOUR_MINUTES = 30;
const HISTORY_DAYS = 14;
const MINIMUM_COVERAGE = 0.9;
const MINIMUM_DAY_SAMPLES = 5;

export interface LoadPlanningSlot {
    localMinute: number;
    homeKw: number | null;
    batteryNetChargeKw: number | null;
    sampleCount: number;
    coverage: number;
}

export interface LoadPlanningContext {
    availability: 'available' | 'unavailable';
    unavailableReason?: 'insufficient-history';
    usableDayCount: number;
    historyStart: string;
    historyEnd: string;
    slots: LoadPlanningSlot[];
}

interface ExpectedDay {
    timestamps: Date[];
    slots: Map<number, Date[]>;
}

interface SlotDayValue {
    homeKw: number;
    batteryNetChargeKw: number;
}

function localMinute(instant: Date, timeZone: string): number {
    const local = Temporal.Instant.from(instant.toISOString()).toZonedDateTimeISO(timeZone);
    return local.hour * 60 + local.minute;
}

function median(values: number[]): number | null {
    if (values.length < MINIMUM_DAY_SAMPLES) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[middle - 1] + sorted[middle]) / 2
        : sorted[middle];
}

/**
 * Build a 14-complete-local-day profile from repository EnergyData rows.
 * Each row stores signed energy in Wh for a five-minute interval, and its
 * timestamp marks that interval's start. Thus six rows span a half hour.
 * `load_power`, `solar_power`, `grid_power`, and `battery_power` are energy
 * values despite their names; battery power is positive for charge and
 * negative for discharge, while grid power is positive import and negative
 * export. Only home load and net battery charge are exposed by this profile.
 *
 * Rows are integrated by their observed duration to derive average kW. A
 * local day and a local half-hour need at least 90% interval coverage to
 * contribute. On fall-back days both occurrences are integrated together
 * before the day casts one vote; nonexistent spring-forward slots cast none.
 */
export function buildLoadPlanningContext(
    rows: EnergyData[],
    timeZone: string,
    asOf: Date
): LoadPlanningContext {
    if (!Number.isFinite(asOf.getTime())) throw new RangeError('asOf must be a valid date');

    const historyEndDate = Temporal.Instant.from(asOf.toISOString()).toZonedDateTimeISO(timeZone).toPlainDate();
    const historyStartDate = historyEndDate.subtract({ days: HISTORY_DAYS });
    const historyStart = new Date(historyStartDate.toZonedDateTime({ timeZone }).epochMilliseconds);
    const historyEnd = new Date(historyEndDate.toZonedDateTime({ timeZone }).epochMilliseconds);

    const expectedDays: ExpectedDay[] = [];
    for (let dayOffset = 0; dayOffset < HISTORY_DAYS; dayOffset += 1) {
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
    for (const row of rows) {
        const time = row.timestamp.getTime();
        if (Number.isFinite(time)
            && Number.isFinite(row.load_power)
            && Number.isFinite(row.battery_power)
            && time >= historyStart.getTime()
            && time < historyEnd.getTime()) {
            rowsByTimestamp.set(time, row);
        }
    }

    const usableDays: ExpectedDay[] = expectedDays.filter((day) => {
        const observed = day.timestamps.reduce((count, timestamp) => count + (rowsByTimestamp.has(timestamp.getTime()) ? 1 : 0), 0);
        return observed / day.timestamps.length >= MINIMUM_COVERAGE;
    });

    const slots: LoadPlanningSlot[] = Array.from({ length: 48 }, (_, index) => {
        const minute = index * HALF_HOUR_MINUTES;
        const dayValues: SlotDayValue[] = [];
        let possibleDays = 0;
        for (const day of usableDays) {
            const expected = day.slots.get(minute);
            if (!expected?.length) continue;
            possibleDays += 1;
            const observedRows = expected
                .map((timestamp) => rowsByTimestamp.get(timestamp.getTime()))
                .filter((row): row is EnergyData => row !== undefined
                    && Number.isFinite(row.load_power) && Number.isFinite(row.battery_power));
            if (observedRows.length / expected.length < MINIMUM_COVERAGE) continue;

            // Every observation represents five minutes; divide integrated Wh
            // by observed hours to get the average power during the slot.
            const observedHours = observedRows.length * INTERVAL_MINUTES / 60;
            const loadWh = observedRows.reduce((sum, row) => sum + row.load_power, 0);
            const batteryWh = observedRows.reduce((sum, row) => sum + row.battery_power, 0);
            dayValues.push({
                homeKw: loadWh / 1000 / observedHours,
                batteryNetChargeKw: batteryWh / 1000 / observedHours,
            });
        }

        const homeKw = median(dayValues.map((value) => value.homeKw));
        const batteryNetChargeKw = median(dayValues.map((value) => value.batteryNetChargeKw));
        return {
            localMinute: minute,
            homeKw,
            batteryNetChargeKw,
            sampleCount: dayValues.length,
            coverage: possibleDays === 0 ? 0 : dayValues.length / possibleDays,
        };
    });

    const enoughHistory = usableDays.length >= MINIMUM_DAY_SAMPLES;
    return {
        availability: enoughHistory ? 'available' : 'unavailable',
        ...(enoughHistory ? {} : { unavailableReason: 'insufficient-history' as const }),
        usableDayCount: usableDays.length,
        historyStart: historyStart.toISOString(),
        historyEnd: historyEnd.toISOString(),
        slots: enoughHistory ? slots : slots.map((slot) => ({ ...slot, homeKw: null, batteryNetChargeKw: null })),
    };
}
