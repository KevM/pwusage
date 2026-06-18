import { describe, it, expect } from 'vitest';
import { canonicalizeSeasons, windowCoverage, seasonCalendarGaps, isFixedSchedule, scheduleHasGaps } from './tou-coverage';
import type { ParsedSeason, ParsedSchedule } from '../importer/tariff-parser';

function win(p: Partial<ParsedSchedule>): ParsedSchedule {
    return {
        name: 'w', buy_rate: 0.2, sell_rate: 0.05,
        from_day_of_week: 0, to_day_of_week: 6,
        from_hour: 0, from_minute: 0, to_hour: 24, to_minute: 0, ...p,
    };
}
function season(p: Partial<ParsedSeason>): ParsedSeason {
    return {
        name: 's', from_month: 1, from_day: 1, to_month: 12, to_day: 31,
        buy_rate: 0, sell_rate: 0, schedules: [win({})], ...p,
    };
}

describe('windowCoverage', () => {
    it('reports no gap when a base all-day/all-week window covers the season', () => {
        const cov = windowCoverage(season({}));
        expect(cov.gaps).toEqual([]);
        expect(cov.grid.length).toBe(7);
        expect(cov.grid[0].length).toBe(24);
    });

    it('reports the uncovered hours when no window covers them', () => {
        const cov = windowCoverage(season({ schedules: [win({ from_day_of_week: 0, to_day_of_week: 4, from_hour: 16, to_hour: 21 })] }));
        expect(cov.gaps.length).toBeGreaterThan(0);
        expect(cov.gaps).toContainEqual({ weekday: 5, hour: 0 });
        expect(cov.gaps).not.toContainEqual({ weekday: 0, hour: 17 });
    });

    it('covers a midnight-crossing window (21->6)', () => {
        const cov = windowCoverage(season({ schedules: [win({ from_hour: 21, to_hour: 6 })] }));
        expect(cov.gaps).not.toContainEqual({ weekday: 0, hour: 23 });
        expect(cov.gaps).not.toContainEqual({ weekday: 0, hour: 3 });
        expect(cov.gaps).toContainEqual({ weekday: 0, hour: 12 });
    });

    it('lets a narrower Sat-Sun all-day window override an Every-Day peak with no false gap', () => {
        const cov = windowCoverage(season({ schedules: [
            win({ name: 'base', from_hour: 0, to_hour: 24 }),
            win({ name: 'peak', from_day_of_week: 0, to_day_of_week: 6, from_hour: 16, to_hour: 21 }),
            win({ name: 'weekend', from_day_of_week: 5, to_day_of_week: 6, from_hour: 0, to_hour: 24 }),
        ] }));
        expect(cov.gaps).toEqual([]);
    });
});

describe('seasonCalendarGaps', () => {
    it('is empty for a single all-year season', () => {
        expect(seasonCalendarGaps([season({})])).toEqual([]);
    });
    it('flags a month not covered by any season', () => {
        const summer = season({ from_month: 6, from_day: 1, to_month: 9, to_day: 30 });
        const gaps = seasonCalendarGaps([summer]);
        expect(gaps).toContainEqual({ month: 1, day: 15, count: 0 });
    });
    it('flags a day covered by two seasons', () => {
        const a = season({ from_month: 1, from_day: 1, to_month: 12, to_day: 31 });
        const b = season({ from_month: 6, from_day: 1, to_month: 6, to_day: 30 });
        const gaps = seasonCalendarGaps([a, b]);
        expect(gaps).toContainEqual({ month: 6, day: 15, count: 2 });
    });
});

describe('canonicalizeSeasons + isFixedSchedule', () => {
    it('collapses an all-same-rate season to one 24/7 window and reads Fixed', () => {
        const multi = season({ schedules: [
            win({ from_hour: 0, to_hour: 16, buy_rate: 0.2, sell_rate: 0.05 }),
            win({ from_hour: 16, to_hour: 24, buy_rate: 0.2, sell_rate: 0.05 }),
        ] });
        const out = canonicalizeSeasons([multi]);
        expect(out[0].schedules.length).toBe(1);
        expect(out[0].schedules[0]).toMatchObject({ from_day_of_week: 0, to_day_of_week: 6, from_hour: 0, to_hour: 24, buy_rate: 0.2 });
        expect(isFixedSchedule(out)).toBe(true);
    });
    it('leaves a genuinely differing season intact and reads TOU', () => {
        const multi = season({ schedules: [
            win({ from_hour: 0, to_hour: 16, buy_rate: 0.18 }),
            win({ from_hour: 16, to_hour: 21, buy_rate: 0.45 }),
            win({ from_hour: 21, to_hour: 24, buy_rate: 0.18 }),
        ] });
        const out = canonicalizeSeasons([multi]);
        expect(out[0].schedules.length).toBe(3);
        expect(isFixedSchedule(out)).toBe(false);
    });
    it('reads TOU when seasons differ in rate even if each season is internally flat', () => {
        const summer = season({ from_month: 6, from_day: 1, to_month: 9, to_day: 30, schedules: [win({ buy_rate: 0.30 })] });
        const winter = season({ from_month: 10, from_day: 1, to_month: 5, to_day: 31, schedules: [win({ buy_rate: 0.20 })] });
        expect(isFixedSchedule([summer, winter])).toBe(false);
    });
});

describe('scheduleHasGaps', () => {
    const flatWindow = {
        name: 'Flat', buy_rate: 0.3, sell_rate: 0.05,
        from_day_of_week: 0, to_day_of_week: 6, from_hour: 0, from_minute: 0, to_hour: 24, to_minute: 0,
    };
    const allYear = (schedules: typeof flatWindow[]) => ([{
        name: 'All Year', from_month: 1, from_day: 1, to_month: 12, to_day: 31,
        buy_rate: 0.3, sell_rate: 0.05, schedules,
    }]);

    it('is false for a full-year/full-week flat plan', () => {
        expect(scheduleHasGaps(allYear([flatWindow]))).toBe(false);
    });

    it('is true when a window leaves hours uncovered', () => {
        expect(scheduleHasGaps(allYear([{ ...flatWindow, from_hour: 6, to_hour: 22 }]))).toBe(true);
    });

    it('is true when seasons leave a calendar day uncovered', () => {
        const jan = { name: 'Jan', from_month: 1, from_day: 1, to_month: 1, to_day: 31, buy_rate: 0.3, sell_rate: 0.05, schedules: [flatWindow] };
        expect(scheduleHasGaps([jan])).toBe(true); // Feb–Dec uncovered
    });
});
