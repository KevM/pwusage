import { describe, expect, it } from 'vitest';
import { Temporal } from '@js-temporal/polyfill';
import type { EnergyData } from './db-types';
import { buildLoadPlanningContext } from './load-planning-context';

const TIME_ZONE = 'America/Los_Angeles';

function rowsForDays(
    startDate: string,
    days: number,
    options: {
        omit?: (date: string, hour: number, minute: number, fold: number) => boolean;
        loadWh?: (date: string, hour: number, minute: number, fold: number) => number;
        batteryWh?: (date: string, hour: number, minute: number, fold: number) => number;
    } = {},
    timeZone = TIME_ZONE
): EnergyData[] {
    const rows: EnergyData[] = [];
    const startDateValue = Temporal.PlainDate.from(startDate);
    for (let offset = 0; offset < days; offset += 1) {
        const date = startDateValue.add({ days: offset });
        const day = date.toString();
        const localStart = date.toZonedDateTime({ timeZone });
        const nextLocalStart = date.add({ days: 1 }).toZonedDateTime({ timeZone });
        const localOccurrences = new Map<number, number>();
        for (let instant = localStart; Temporal.ZonedDateTime.compare(instant, nextLocalStart) < 0; instant = instant.add({ minutes: 5 })) {
                const hour = instant.hour;
                const minute = instant.minute;
                const localMinute = hour * 60 + minute;
                const fold = localOccurrences.get(localMinute) ?? 0;
                localOccurrences.set(localMinute, fold + 1);
                if (options.omit?.(day, hour, minute, fold)) continue;
                rows.push({
                    timestamp: new Date(instant.epochMilliseconds),
                    site_id: 'site-a', tariff_id: 1, tariff_schedule_id: null,
                    // Repository semantics: each field is signed Wh for the five-minute interval,
                    // timestamped at that interval's start. Battery charge is positive; discharge is negative.
                    load_power: options.loadWh?.(day, hour, minute, fold) ?? 100,
                    solar_power: 50,
                    grid_power: 20,
                    battery_power: options.batteryWh?.(day, hour, minute, fold) ?? (minute === 0 ? 100 : -50),
                    battery_soc: null,
                });
        }
    }
    return rows;
}

describe('buildLoadPlanningContext', () => {
    it('returns 48 half-hour slots and converts interval Wh into median kW per local day', () => {
        const rows = rowsForDays('2026-08-01', 14, {
            loadWh: (_day, hour, minute) => hour === 8 && minute < 30 ? 300 : 100,
        });

        const result = buildLoadPlanningContext(rows, TIME_ZONE, new Date('2026-08-15T07:00:00Z'));

        expect(result.slots).toHaveLength(48);
        const morning = result.slots.find((slot) => slot.localMinute === 8 * 60);
        expect(morning).toMatchObject({ homeKw: 3.6, batteryNetChargeKw: -0.3, sampleCount: 14 });
        expect(result.historyStart).toBe('2026-08-01T07:00:00.000Z');
        expect(result.historyEnd).toBe('2026-08-15T07:00:00.000Z');
    });

    it('uses the median so one discretionary-load day does not dominate a slot', () => {
        const rows = rowsForDays('2026-08-01', 14, {
            loadWh: (day, hour) => hour === 8 && day === '2026-08-07' ? 1800 : 100,
        });

        const result = buildLoadPlanningContext(rows, TIME_ZONE, new Date('2026-08-15T07:00:00Z'));

        expect(result.slots.find((slot) => slot.localMinute === 8 * 60)?.homeKw).toBe(1.2);
    });

    it('preserves positive charging and negative discharge in the median profiles', () => {
        const rows = rowsForDays('2026-08-01', 14, {
            batteryWh: (_day, hour) => hour === 8 ? 100 : hour === 9 ? -50 : 0,
        });

        const result = buildLoadPlanningContext(rows, TIME_ZONE, new Date('2026-08-15T07:00:00Z'));

        expect(result.slots.find((slot) => slot.localMinute === 8 * 60)?.batteryNetChargeKw).toBe(1.2);
        expect(result.slots.find((slot) => slot.localMinute === 9 * 60)?.batteryNetChargeKw).toBe(-0.6);
    });

    it('does not count a half-hour with less than 90 percent observed intervals', () => {
        const rows = rowsForDays('2026-08-01', 14, {
            omit: (day, hour, minute) => day === '2026-08-04' && hour === 8 && minute === 10,
        });

        const result = buildLoadPlanningContext(rows, TIME_ZONE, new Date('2026-08-15T07:00:00Z'));

        expect(result.slots.find((slot) => slot.localMinute === 8 * 60)?.sampleCount).toBe(13);
    });

    it('excludes a local day when its total observed interval coverage is below 90 percent', () => {
        const rows = rowsForDays('2026-08-01', 14, {
            omit: (day, hour) => day === '2026-08-04' && hour < 6,
        });

        const result = buildLoadPlanningContext(rows, TIME_ZONE, new Date('2026-08-15T07:00:00Z'));

        expect(result.usableDayCount).toBe(13);
        expect(result.slots.find((slot) => slot.localMinute === 8 * 60)?.sampleCount).toBe(13);
    });

    it('collapses the repeated fall-back slot to one day vote and leaves spring-forward slots missing', () => {
        const rows = rowsForDays('2026-10-20', 14);
        const result = buildLoadPlanningContext(rows, TIME_ZONE, new Date('2026-11-03T08:00:00Z'));

        expect(result.slots).toHaveLength(48);
        expect(result.slots.find((slot) => slot.localMinute === 60)?.sampleCount).toBe(14);
        expect(result.slots.find((slot) => slot.localMinute === 150)?.sampleCount).toBe(14);
    });

    it('uses true start-of-day boundaries through a skipped Santiago midnight', () => {
        const rows = rowsForDays('2026-09-06', 14, {}, 'America/Santiago');
        rows.push({
            ...rows[0],
            timestamp: new Date('2026-09-20T03:00:00.000Z'),
            load_power: 100_000,
        });
        const result = buildLoadPlanningContext(rows, 'America/Santiago', new Date('2026-09-20T12:00:00Z'));

        expect(result.historyStart).toBe('2026-09-06T04:00:00.000Z');
        expect(result.historyEnd).toBe('2026-09-20T03:00:00.000Z');
        expect(result.slots.find((slot) => slot.localMinute === 0)?.sampleCount).toBe(13);
        expect(result.slots.find((slot) => slot.localMinute === 0)?.homeKw).toBe(1.2);
        expect(result.slots.find((slot) => slot.localMinute === 30)?.sampleCount).toBe(13);
    });

    it('keeps the 90-percent daily coverage vote on its Santiago calendar date', () => {
        const rows = rowsForDays('2026-09-06', 14, {
            omit: (date, hour, minute) => date === '2026-09-07'
                && (hour < 2 || (hour === 2 && minute < 30)),
        }, 'America/Santiago');
        const result = buildLoadPlanningContext(rows, 'America/Santiago', new Date('2026-09-20T12:00:00Z'));

        expect(result.usableDayCount).toBe(13);
        expect(result.slots.find((slot) => slot.localMinute === 8 * 60)?.sampleCount).toBe(13);
    });

    it('does not invent spring-forward local half-hours', () => {
        const rows = rowsForDays('2026-02-24', 14);
        const result = buildLoadPlanningContext(rows, TIME_ZONE, new Date('2026-03-10T07:00:00Z'));

        expect(result.slots.find((slot) => slot.localMinute === 150)?.sampleCount).toBe(13);
    });

    it('returns an explicit unavailable result when fewer than five days meet coverage', () => {
        const rows = rowsForDays('2026-08-01', 4);

        const result = buildLoadPlanningContext(rows, TIME_ZONE, new Date('2026-08-05T07:00:00Z'));

        expect(result.availability).toBe('unavailable');
        expect(result.unavailableReason).toBe('insufficient-history');
        expect(result.slots).toHaveLength(48);
        expect(result.slots.every((slot) => slot.homeKw === null && slot.batteryNetChargeKw === null)).toBe(true);
    });

    // A stored timestamp that lands a few seconds off the site-local five-minute
    // grid must not silently empty the whole profile.
    it.each([1000, 30_000, 60_000])('tolerates a %ims offset between stored rows and the local grid', (offsetMs) => {
        const rows = rowsForDays('2026-08-01', 14, {
            loadWh: (_day, hour, minute) => (hour === 8 && minute < 30 ? 300 : 100),
        }).map((row) => ({ ...row, timestamp: new Date(row.timestamp.getTime() + offsetMs) }));

        const result = buildLoadPlanningContext(rows, TIME_ZONE, new Date('2026-08-15T07:00:00Z'));

        expect(result.availability).toBe('available');
        const morning = result.slots.find((slot) => slot.localMinute === 8 * 60);
        expect(morning?.homeKw).toBe(3.6);
        expect(morning?.sampleCount).toBe(14);
    });

    it('does not let a tolerance window assign one row to two intervals', () => {
        // Two rows three seconds apart must still yield one observation per slot.
        const rows = rowsForDays('2026-08-01', 14).flatMap((row) => ([
            { ...row, timestamp: new Date(row.timestamp.getTime() - 1500) },
            { ...row, timestamp: new Date(row.timestamp.getTime() + 1500) },
        ]));

        const result = buildLoadPlanningContext(rows, TIME_ZONE, new Date('2026-08-15T07:00:00Z'));

        expect(result.availability).toBe('available');
        const midnight = result.slots.find((slot) => slot.localMinute === 0);
        // 100 Wh over one five-minute interval is 1.2 kW. Doubling the rows must
        // not change it, which is what an unclamped tolerance window would do.
        expect(midnight?.homeKw).toBe(1.2);
        expect(midnight?.coverage).toBeLessThanOrEqual(1);
    });

    it('reports a distinguishable reason when stored rows never land on the grid', () => {
        // Seven minutes is neither on the five-minute grid nor inside tolerance.
        const rows = rowsForDays('2026-08-01', 14)
            .map((row) => ({ ...row, timestamp: new Date(row.timestamp.getTime() + 7 * 60 * 1000) }));

        const result = buildLoadPlanningContext(rows, TIME_ZONE, new Date('2026-08-15T07:00:00Z'));

        expect(result.availability).toBe('unavailable');
        expect(result.unavailableReason).toBe('timestamp-misaligned');
    });
});
