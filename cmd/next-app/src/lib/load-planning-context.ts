import type { EnergyData } from './db-types';
import { alignHistoryDays, averageKw, observedSlotRows } from './load-planning-days';

const HALF_HOUR_MINUTES = 30;
const HISTORY_DAYS = 14;
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
    unavailableReason?: 'insufficient-history' | 'timestamp-misaligned';
    usableDayCount: number;
    historyStart: string;
    historyEnd: string;
    slots: LoadPlanningSlot[];
}

interface SlotDayValue {
    homeKw: number;
    batteryNetChargeKw: number;
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

    const { days: usableDays, rowsByTimestamp, candidateRows, unalignedRows, historyStart, historyEnd } =
        alignHistoryDays(rows, timeZone, asOf, HISTORY_DAYS);

    const slots: LoadPlanningSlot[] = Array.from({ length: 48 }, (_, index) => {
        const minute = index * HALF_HOUR_MINUTES;
        const dayValues: SlotDayValue[] = [];
        let possibleDays = 0;
        for (const day of usableDays) {
            const observed = observedSlotRows(day, minute, rowsByTimestamp,
                (row) => Number.isFinite(row.load_power) && Number.isFinite(row.battery_power));
            if (!observed.possible) continue;
            possibleDays += 1;
            if (!observed.rows) continue;
            dayValues.push({
                homeKw: averageKw(observed.rows, (row) => row.load_power),
                batteryNetChargeKw: averageKw(observed.rows, (row) => row.battery_power),
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
    // Distinguish "this site has no history yet" from "history exists but never
    // lines up with the local grid", which the client cannot act on either way.
    const misaligned = candidateRows > 0 && unalignedRows === candidateRows;
    return {
        availability: enoughHistory ? 'available' : 'unavailable',
        ...(enoughHistory ? {} : { unavailableReason: misaligned ? 'timestamp-misaligned' as const : 'insufficient-history' as const }),
        usableDayCount: usableDays.length,
        historyStart: historyStart.toISOString(),
        historyEnd: historyEnd.toISOString(),
        slots: enoughHistory ? slots : slots.map((slot) => ({ ...slot, homeKw: null, batteryNetChargeKw: null })),
    };
}
