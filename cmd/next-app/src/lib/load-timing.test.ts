import { describe, it, expect } from 'vitest';
import { computeLoadTiming } from './load-timing';
import { Schedule } from './schedule';
import type { UsageData } from './energy-repo';
import type { Tariff } from './db';

const TZ = 'America/Los_Angeles';

function tariff(): Tariff {
    return {
        id: 1, name: 'TOU-D', site_id: 's1',
        seasons: [{
            id: 1, tariff_id: 1, name: 'All', from_month: 1, from_day: 1, to_month: 12, to_day: 31,
            buy_rate: 0.30, sell_rate: 0.05,
            schedules: [
                { id: 10, season_id: 1, name: 'OFF_PEAK', from_day_of_week: 0, to_day_of_week: 6,
                  from_hour: 0, from_minute: 0, to_hour: 16, to_minute: 0, buy_rate: 0.20, sell_rate: 0.05 },
                { id: 11, season_id: 1, name: 'ON_PEAK', from_day_of_week: 0, to_day_of_week: 6,
                  from_hour: 16, from_minute: 0, to_hour: 21, to_minute: 0, buy_rate: 0.50, sell_rate: 0.08 },
                { id: 12, season_id: 1, name: 'OFF_PEAK_LATE', from_day_of_week: 0, to_day_of_week: 6,
                  from_hour: 21, from_minute: 0, to_hour: 24, to_minute: 0, buy_rate: 0.20, sell_rate: 0.05 }
            ]
        }]
    } as unknown as Tariff;
}

function usage(touName: string, buyRate: number, sellRate: number, gridUsage: number): UsageData {
    return {
        start: new Date('2026-05-01T00:00:00Z'),
        homeUsage: 0, gridUsage, solarProduction: 0, batteryChange: 0,
        tariff: tariff(), touName, buyRate, sellRate
    };
}

describe('computeLoadTiming', () => {
    it('reports no tariff when schedule has no periods', () => {
        const schedule = new Schedule([], TZ);
        const view = computeLoadTiming(schedule, [], new Date(), TZ, null);
        expect(view.hasTariff).toBe(false);
        expect(view.hasCycleData).toBe(false);
        expect(view.periods).toEqual([]);
    });

    it('marks the active period and computes marginal cost per basis', () => {
        const schedule = new Schedule([tariff()], TZ);
        const now = new Date('2026-05-19T19:00:00Z');
        const cycle: UsageData[] = [
            usage('OFF_PEAK', 0.20, 0.05, 5000),
            usage('ON_PEAK', 0.50, 0.08, -9000),
            usage('OFF_PEAK_LATE', 0.20, 0.05, 0)
        ];
        const active = { name: 'OFF_PEAK', buyRate: 0.20, sellRate: 0.05 };
        const view = computeLoadTiming(schedule, cycle, now, TZ, active);

        expect(view.hasTariff).toBe(true);
        expect(view.hasCycleData).toBe(true);
        const off = view.periods.find((p) => p.name === 'OFF_PEAK')!;
        expect(off.isActive).toBe(true);
        expect(off.basis).toBe('buy');
        expect(off.marginalCost).toBeCloseTo(0.20);
        const on = view.periods.find((p) => p.name === 'ON_PEAK')!;
        expect(on.basis).toBe('sell');
        expect(on.marginalCost).toBeCloseTo(0.08);
        expect(on.isActive).toBe(false);
    });

    it('finds the next cheaper period with a relative phrase', () => {
        const schedule = new Schedule([tariff()], TZ);
        const now = new Date('2026-05-19T20:00:00Z');
        const cycle: UsageData[] = [
            usage('OFF_PEAK', 0.20, 0.05, 5000),
            usage('ON_PEAK', 0.50, 0.08, 5000),
            usage('OFF_PEAK_LATE', 0.20, 0.05, -9000)
        ];
        const active = { name: 'OFF_PEAK', buyRate: 0.20, sellRate: 0.05 };
        const view = computeLoadTiming(schedule, cycle, now, TZ, active);
        expect(view.nextCheaper).not.toBeNull();
        expect(typeof view.nextCheaper!.phrase).toBe('string');
        expect(view.nextCheaper!.phrase.length).toBeGreaterThan(0);
    });

    it('computes activeIsCheapest only when active is the cycle minimum', () => {
        const schedule = new Schedule([tariff()], TZ);
        const now = new Date('2026-05-19T19:00:00Z');
        const active = { name: 'OFF_PEAK', buyRate: 0.20, sellRate: 0.05 };
        const cheapestActive: UsageData[] = [
            usage('OFF_PEAK', 0.20, 0.05, 5000),
            usage('ON_PEAK', 0.50, 0.08, 5000)
        ];
        expect(computeLoadTiming(schedule, cheapestActive, now, TZ, active).activeIsCheapest).toBe(true);
    });
});
