import type { EnergyData } from './db-types';
import { alignHistoryDays, averageKw, HALF_HOUR_MINUTES, observedSlotRows } from './load-planning-days';

export const GRID_HISTORY_DAYS = 28;
const MINIMUM_USABLE_DAYS = 5;
/** The cautious "dull day" band, by whole-day grid net export (about 1 in 4). */
const CAUTIOUS_BAND_LOW = 0.2;
const CAUTIOUS_BAND_HIGH = 0.3;

export interface GridHistorySlot {
    localMinute: number;
    /** Median across usable days of the slot's average grid net export (kW, export positive). */
    gridNetExportKw: number | null;
    /** Mean slot profile of the 1-in-4 dull days (20th–30th percentile by whole-day export). */
    cautiousGridNetExportKw: number | null;
    /** Median across usable days of the slot's average solar (kW). */
    solarKw: number | null;
}

export interface GridHistory {
    usableDayCount: number;
    historyStart: string;
    historyEnd: string;
    slots: GridHistorySlot[];
}

function median(values: number[]): number | null {
    if (values.length < MINIMUM_USABLE_DAYS) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[middle - 1] + sorted[middle]) / 2
        : sorted[middle];
}

function mean(values: number[]): number | null {
    if (values.length === 0) return null;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * The ranked days whose empirical percentile, rank / (n − 1), lies in the
 * 20th–30th band. When none does (a handful of days), the one day nearest the
 * band's middle, so a short history never averages in the median day.
 */
function cautiousBand(ranked: number[]): number[] {
    const lastIndex = ranked.length - 1;
    if (lastIndex <= 0) return ranked.slice(0, 1);
    const inBand = ranked.filter((_, rank) => {
        const percentile = rank / lastIndex;
        return percentile >= CAUTIOUS_BAND_LOW - 1e-9 && percentile <= CAUTIOUS_BAND_HIGH + 1e-9;
    });
    if (inBand.length > 0) return inBand;
    const middle = (CAUTIOUS_BAND_LOW + CAUTIOUS_BAND_HIGH) / 2;
    return [ranked[Math.round(middle * lastIndex)]];
}

const hasGridAndSolar = (row: EnergyData) => Number.isFinite(row.grid_power) && Number.isFinite(row.solar_power);
const netExportWh = (row: EnergyData) => -row.grid_power;

/**
 * Per local half-hour, the site's grid net export and solar over the last
 * `days` complete local days, for projecting rate-period banks past the solar
 * forecast. Days and slots follow `buildLoadPlanningContext`'s coverage rules
 * (90% per day and per slot, at least five usable days, fall-back hours
 * integrated together for one vote).
 *
 * Typical is the per-slot median. Cautious is a real "dull day": the usable
 * days are ranked by whole-day net export and the days in the 20th–30th
 * percentile band (at least one) are averaged slot by slot.
 */
export function buildGridHistory(
    rows: EnergyData[],
    timeZone: string,
    asOf: Date,
    days: number = GRID_HISTORY_DAYS
): GridHistory {
    if (!Number.isFinite(asOf.getTime())) throw new RangeError('asOf must be a valid date');

    const aligned = alignHistoryDays(rows, timeZone, asOf, days);
    const usableDays = aligned.days;
    const enoughHistory = usableDays.length >= MINIMUM_USABLE_DAYS;

    const slotMinutes = Array.from({ length: 48 }, (_, index) => index * HALF_HOUR_MINUTES);
    // dayValues[d][slot] = { exportKw, solarKw } or null when the slot is uncovered.
    const dayValues = usableDays.map((day) => slotMinutes.map((minute) => {
        const observed = observedSlotRows(day, minute, aligned.rowsByTimestamp, hasGridAndSolar);
        if (!observed.rows) return null;
        return {
            exportKw: averageKw(observed.rows, netExportWh),
            solarKw: averageKw(observed.rows, (row) => row.solar_power),
        };
    }));

    // Rank days by whole-day net export: the mean over the day's observed
    // intervals, so a few missing intervals do not make a day look dull.
    const dayExport = usableDays.map((day) => {
        const observed = day.timestamps
            .map((timestamp) => aligned.rowsByTimestamp.get(timestamp.getTime()))
            .filter((row): row is EnergyData => row !== undefined && hasGridAndSolar(row));
        return observed.length === 0 ? 0 : averageKw(observed, netExportWh);
    });
    const ranked = usableDays.map((_, index) => index).sort((a, b) => dayExport[a] - dayExport[b]);
    const bandDays = cautiousBand(ranked);

    const slots: GridHistorySlot[] = slotMinutes.map((minute, slotIndex) => {
        if (!enoughHistory) {
            return { localMinute: minute, gridNetExportKw: null, cautiousGridNetExportKw: null, solarKw: null };
        }
        const covered = dayValues.flatMap((values) => values[slotIndex] ? [values[slotIndex]] : []);
        const bandCovered = bandDays.flatMap((dayIndex) => {
            const value = dayValues[dayIndex][slotIndex];
            return value ? [value.exportKw] : [];
        });
        return {
            localMinute: minute,
            gridNetExportKw: median(covered.map((value) => value.exportKw)),
            cautiousGridNetExportKw: mean(bandCovered),
            solarKw: median(covered.map((value) => value.solarKw)),
        };
    });

    return {
        usableDayCount: usableDays.length,
        historyStart: aligned.historyStart.toISOString(),
        historyEnd: aligned.historyEnd.toISOString(),
        slots,
    };
}
