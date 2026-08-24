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

    it('groups periods with same TOU name across seasons and uses current active rates', () => {
        // Multi-season tariff: Summer (June-September) and Winter (October-May)
        // Current active season at now (June 15) is Summer.
        const multiSeasonTariff = {
            id: 2, name: 'TOU-Seasonal', site_id: 's1',
            seasons: [
                {
                    id: 1, tariff_id: 2, name: 'Summer', from_month: 6, from_day: 1, to_month: 9, to_day: 30,
                    buy_rate: 0.30, sell_rate: 0.05,
                    schedules: [
                        { id: 10, season_id: 1, name: 'OFF_PEAK', from_day_of_week: 0, to_day_of_week: 6,
                          from_hour: 0, from_minute: 0, to_hour: 16, to_minute: 0, buy_rate: 0.15, sell_rate: 0.03 },
                        { id: 11, season_id: 1, name: 'ON_PEAK', from_day_of_week: 0, to_day_of_week: 6,
                          from_hour: 16, from_minute: 0, to_hour: 24, to_minute: 0, buy_rate: 0.40, sell_rate: 0.08 }
                    ]
                },
                {
                    id: 2, tariff_id: 2, name: 'Winter', from_month: 10, from_day: 1, to_month: 5, to_day: 31,
                    buy_rate: 0.30, sell_rate: 0.05,
                    schedules: [
                        { id: 20, season_id: 2, name: 'OFF_PEAK', from_day_of_week: 0, to_day_of_week: 6,
                          from_hour: 0, from_minute: 0, to_hour: 16, to_minute: 0, buy_rate: 0.20, sell_rate: 0.05 },
                        { id: 21, season_id: 2, name: 'ON_PEAK', from_day_of_week: 0, to_day_of_week: 6,
                          from_hour: 16, from_minute: 0, to_hour: 24, to_minute: 0, buy_rate: 0.50, sell_rate: 0.10 }
                    ]
                }
            ]
        } as unknown as Tariff;

        const schedule = new Schedule([multiSeasonTariff], TZ);
        // now is June 15, 2026 (Summer is active)
        const now = new Date('2026-06-15T12:00:00Z');

        // Cycle data contains entries from Winter (e.g. May) and Summer (June)
        const cycle: UsageData[] = [
            // Winter rows
            { start: new Date('2026-05-15T00:00:00Z'), homeUsage: 0, gridUsage: 10000, solarProduction: 0, batteryChange: 0, tariff: multiSeasonTariff, touName: 'OFF_PEAK', buyRate: 0.20, sellRate: 0.05 },
            { start: new Date('2026-05-15T00:00:00Z'), homeUsage: 0, gridUsage: -5000, solarProduction: 0, batteryChange: 0, tariff: multiSeasonTariff, touName: 'ON_PEAK', buyRate: 0.50, sellRate: 0.10 },
            // Summer rows
            { start: new Date('2026-06-15T00:00:00Z'), homeUsage: 0, gridUsage: 5000, solarProduction: 0, batteryChange: 0, tariff: multiSeasonTariff, touName: 'OFF_PEAK', buyRate: 0.15, sellRate: 0.03 },
            { start: new Date('2026-06-15T00:00:00Z'), homeUsage: 0, gridUsage: -2000, solarProduction: 0, batteryChange: 0, tariff: multiSeasonTariff, touName: 'ON_PEAK', buyRate: 0.40, sellRate: 0.08 }
        ];

        const active = { name: 'OFF_PEAK', buyRate: 0.15, sellRate: 0.03 };
        const view = computeLoadTiming(schedule, cycle, now, TZ, active);

        // Should group by touName, so only 2 periods are returned (OFF_PEAK and ON_PEAK)
        expect(view.periods.length).toBe(2);

        // OFF_PEAK: combined gridUsage is 10000 + 5000 = 15000 Wh.
        // It is net import (since gridUsage > 0 is net import) -> basis 'buy', marginalCost = buyRate.
        // Summer active buyRate is 0.15.
        const off = view.periods.find(p => p.name === 'OFF_PEAK')!;
        expect(off.marginalCost).toBeCloseTo(0.15);
        expect(off.basis).toBe('buy');
        expect(off.isActive).toBe(true);

        // ON_PEAK: combined gridUsage is -5000 + -2000 = -7000 Wh.
        // Net export = 7 kWh > 0 -> basis 'sell', marginalCost = sellRate.
        // Summer active sellRate is 0.08.
        const on = view.periods.find(p => p.name === 'ON_PEAK')!;
        expect(on.marginalCost).toBeCloseTo(0.08);
        expect(on.basis).toBe('sell');
        expect(on.isActive).toBe(false);
    });

    it('exposes both sides of the price cliff on every period', () => {
        const schedule = new Schedule([tariff()], TZ);
        const now = new Date('2026-05-19T19:00:00Z');
        const cycle: UsageData[] = [
            usage('OFF_PEAK', 0.20, 0.05, 5000),
            usage('ON_PEAK', 0.50, 0.08, -9000),
            usage('OFF_PEAK_LATE', 0.20, 0.05, 0)
        ];
        const active = { name: 'OFF_PEAK', buyRate: 0.20, sellRate: 0.05 };
        const view = computeLoadTiming(schedule, cycle, now, TZ, active);

        for (const p of view.periods) {
            expect(typeof p.buyRate).toBe('number');
            expect(typeof p.sellRate).toBe('number');
        }

        for (const p of view.periods) {
            if (p.marginalCost === null) continue;
            expect([p.buyRate, p.sellRate]).toContain(p.marginalCost);
        }
    });
});

