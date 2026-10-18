import { describe, expect, it } from 'vitest';
import { Temporal } from '@js-temporal/polyfill';
import type { EnergyData } from './db-types';
import { buildGridHistory, GRID_HISTORY_DAYS } from './load-planning-grid-history';

const TIME_ZONE = 'America/Chicago';

/** Wh in one five-minute interval for an average power in kW. */
function wh(kw: number): number {
    return kw * 1000 * 5 / 60;
}

function rowsForDays(
    startDate: string,
    days: number,
    options: {
        exportKw?: (dayIndex: number, hour: number, minute: number, fold: number) => number;
        solarKw?: (dayIndex: number, hour: number, minute: number) => number;
    } = {}
): EnergyData[] {
    const rows: EnergyData[] = [];
    const first = Temporal.PlainDate.from(startDate);
    for (let dayIndex = 0; dayIndex < days; dayIndex += 1) {
        const date = first.add({ days: dayIndex });
        const start = date.toZonedDateTime({ timeZone: TIME_ZONE });
        const next = date.add({ days: 1 }).toZonedDateTime({ timeZone: TIME_ZONE });
        const occurrences = new Map<number, number>();
        for (let instant = start; Temporal.ZonedDateTime.compare(instant, next) < 0; instant = instant.add({ minutes: 5 })) {
            const minuteOfDay = instant.hour * 60 + instant.minute;
            const fold = occurrences.get(minuteOfDay) ?? 0;
            occurrences.set(minuteOfDay, fold + 1);
            rows.push({
                timestamp: new Date(instant.epochMilliseconds),
                site_id: 'site-a', tariff_id: 1, tariff_schedule_id: null,
                load_power: wh(1),
                solar_power: wh(options.solarKw?.(dayIndex, instant.hour, instant.minute) ?? 0),
                // Grid power is positive for import, so export is negative.
                grid_power: -wh(options.exportKw?.(dayIndex, instant.hour, instant.minute, fold) ?? 0),
                battery_power: 0,
                battery_soc: null,
            });
        }
    }
    return rows;
}

function slotAt(history: ReturnType<typeof buildGridHistory>, minute: number) {
    const slot = history.slots.find((candidate) => candidate.localMinute === minute);
    if (!slot) throw new Error(`no slot at ${minute}`);
    return slot;
}

// 28 complete local days 2026-09-20 … 2026-10-17, read on 2026-10-18.
const AS_OF = new Date('2026-10-18T15:00:00Z');

describe('buildGridHistory', () => {
    it('typicalIsMedianNetExportPerSlot', () => {
        const rows = rowsForDays('2026-09-20', 28, {
            exportKw: (dayIndex, hour) => hour === 12 ? dayIndex + 1 : 0,
        });

        const history = buildGridHistory(rows, TIME_ZONE, AS_OF);

        expect(GRID_HISTORY_DAYS).toBe(28);
        expect(history.usableDayCount).toBe(28);
        expect(history.slots).toHaveLength(48);
        expect(slotAt(history, 720).gridNetExportKw).toBeCloseTo(14.5, 9);
        expect(slotAt(history, 0).gridNetExportKw).toBeCloseTo(0, 9);
        expect(history.historyStart).toBe('2026-09-20T05:00:00.000Z');
        expect(history.historyEnd).toBe('2026-10-18T05:00:00.000Z');
    });

    it('cautiousIsTheOneInFourDayProfile', () => {
        // Day d exports d kW at noon and a little at 13:00, so whole-day
        // export ranks the days by d. Day order is shuffled to prove ranking.
        const exportByDay = Array.from({ length: 28 }, (_, index) => ((index * 11) % 28) + 1);
        const rows = rowsForDays('2026-09-20', 28, {
            exportKw: (dayIndex, hour) => hour === 12 ? exportByDay[dayIndex] : hour === 13 ? exportByDay[dayIndex] / 10 : 0,
        });

        const history = buildGridHistory(rows, TIME_ZONE, AS_OF);

        // Sorted indexes floor(0.2*27)=5 … ceil(0.3*27)=9 hold d = 6 … 10.
        expect(slotAt(history, 720).cautiousGridNetExportKw).toBeCloseTo((6 + 7 + 8 + 9 + 10) / 5, 9);
        expect(slotAt(history, 780).cautiousGridNetExportKw).toBeCloseTo(0.8, 9);
    });

    it('solarIsMedianPerSlot', () => {
        const rows = rowsForDays('2026-09-20', 28, {
            solarKw: (dayIndex, hour) => hour === 11 ? (dayIndex % 7) : 0,
        });

        const history = buildGridHistory(rows, TIME_ZONE, AS_OF);

        // Four of each 0…6: the median of 28 values is 3.
        expect(slotAt(history, 660).solarKw).toBeCloseTo(3, 9);
        expect(slotAt(history, 0).solarKw).toBeCloseTo(0, 9);
    });

    it('needsFiveUsableDays', () => {
        const rows = rowsForDays('2026-10-14', 4, { exportKw: () => 2, solarKw: () => 1 });

        const history = buildGridHistory(rows, TIME_ZONE, AS_OF);

        expect(history.usableDayCount).toBe(4);
        expect(history.slots).toHaveLength(48);
        for (const slot of history.slots) {
            expect(slot).toMatchObject({ gridNetExportKw: null, cautiousGridNetExportKw: null, solarKw: null });
        }
    });

    it('historyFillFollowsFallBack', () => {
        // Six days, 2026-10-28 … 2026-11-02; 2026-11-01 repeats 01:00–01:59.
        // That day exports 2 kW in the first 01:00 hour and 6 kW in the
        // second; integrated together it casts one 4 kW vote. Other days
        // export 0, 0, 100, 100, 100 so a double vote would move the median.
        const others = [0, 0, 100, 100, 100];
        const rows = rowsForDays('2026-10-28', 6, {
            exportKw: (dayIndex, hour, _minute, fold) => {
                if (hour !== 1) return 0;
                if (dayIndex === 4) return fold === 0 ? 2 : 6;
                return others[dayIndex < 4 ? dayIndex : dayIndex - 1];
            },
        });

        const history = buildGridHistory(rows, TIME_ZONE, new Date('2026-11-03T12:00:00Z'), 6);

        expect(history.usableDayCount).toBe(6);
        expect(slotAt(history, 60).gridNetExportKw).toBeCloseTo((4 + 100) / 2, 9);
        expect(slotAt(history, 90).gridNetExportKw).toBeCloseTo((4 + 100) / 2, 9);
    });
});
