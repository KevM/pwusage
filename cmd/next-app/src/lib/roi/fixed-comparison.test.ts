import { describe, it, expect } from 'vitest';
import { buildFixedComparisonInput } from './fixed-comparison';
import { Schedule } from '../schedule';
import type { Tariff } from '../db';

function asTariff(parsed: ReturnType<typeof buildFixedComparisonInput>): Tariff {
    return {
        id: 1, site_id: 's1', updated: new Date(), name: parsed.name,
        reporting_only: true, effective_from: null,
        seasons: parsed.seasons.map((s, si) => ({
            id: si + 1, tariff_id: 1, name: s.name,
            from_month: s.from_month, from_day: s.from_day, to_month: s.to_month, to_day: s.to_day,
            buy_rate: s.buy_rate, sell_rate: s.sell_rate,
            schedules: s.schedules.map((sc, ci) => ({
                id: ci + 1, season_id: si + 1, name: sc.name,
                buy_rate: sc.buy_rate, sell_rate: sc.sell_rate,
                from_day_of_week: sc.from_day_of_week, to_day_of_week: sc.to_day_of_week,
                from_hour: sc.from_hour, from_minute: sc.from_minute, to_hour: sc.to_hour, to_minute: sc.to_minute,
            })),
        })),
    };
}

describe('buildFixedComparisonInput', () => {
    it('uses 0..6 day-of-week so every day matches (the gotcha)', () => {
        const sched = buildFixedComparisonInput({ name: 'Flat', buyRate: 0.2, sellRate: 0.05 }).seasons[0].schedules[0];
        expect(sched.from_day_of_week).toBe(0);
        expect(sched.to_day_of_week).toBe(6);
    });

    it('resolves a non-null period for a Wednesday 03:00 and a Sunday 20:00', () => {
        const tariff = asTariff(buildFixedComparisonInput({ name: 'Flat', buyRate: 0.2, sellRate: 0.05 }));
        const schedule = new Schedule([tariff], 'UTC');
        const wed = new Date('2026-01-07T03:00:00Z'); // Wednesday
        const sun = new Date('2026-01-04T20:00:00Z'); // Sunday
        expect(schedule.getTariffPeriod(wed)).not.toBeNull();
        expect(schedule.getTariffPeriod(sun)).not.toBeNull();
    });
});
