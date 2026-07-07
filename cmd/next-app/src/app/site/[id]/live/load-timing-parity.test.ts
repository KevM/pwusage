import { describe, it, expect } from 'vitest';
import { computeLoadTiming } from '@/lib/load-timing';
import { findNextCheaperPeriod, findNextStartsByKey, formatRelativeStart } from '@/lib/next-cheaper-period';
import { computeMarginalCost } from '@/lib/marginal-cost';
import { Schedule } from '@/lib/schedule';
import type { UsageData } from '@/lib/energy-repo';
import type { Tariff } from '@/lib/db';

const TZ = 'America/Los_Angeles';

function fixture(): { schedule: Schedule; cycle: UsageData[]; active: { name: string; buyRate: number; sellRate: number } } {
    const t = {
        id: 1, name: 'TOU-D', site_id: 's1',
        seasons: [{
            id: 1, tariff_id: 1, name: 'All', from_month: 1, from_day: 1, to_month: 12, to_day: 31,
            buy_rate: 0.30, sell_rate: 0.05,
            schedules: [
                { id: 10, season_id: 1, name: 'OFF_PEAK', from_day_of_week: 0, to_day_of_week: 6, from_hour: 0, from_minute: 0, to_hour: 16, to_minute: 0, buy_rate: 0.20, sell_rate: 0.05 },
                { id: 11, season_id: 1, name: 'ON_PEAK', from_day_of_week: 0, to_day_of_week: 6, from_hour: 16, from_minute: 0, to_hour: 21, to_minute: 0, buy_rate: 0.50, sell_rate: 0.08 }
            ]
        }]
    } as unknown as Tariff;
    const mk = (touName: string, buyRate: number, sellRate: number, gridUsage: number): UsageData => ({
        start: new Date('2026-05-01T00:00:00Z'), homeUsage: 0, gridUsage, solarProduction: 0, batteryChange: 0,
        tariff: t, touName, buyRate, sellRate
    });
    return {
        schedule: new Schedule([t], TZ),
        cycle: [mk('OFF_PEAK', 0.20, 0.05, 5000), mk('ON_PEAK', 0.50, 0.08, -9000)],
        active: { name: 'OFF_PEAK', buyRate: 0.20, sellRate: 0.05 }
    };
}

describe('live page parity: computeLoadTiming vs former inline logic', () => {
    it('produces identical nextCheaper / activeIsCheapest / nextStarts', () => {
        const { schedule, cycle, active } = fixture();
        const now = new Date('2026-05-19T20:00:00Z');

        // Former inline computation, reproduced verbatim:
        const inlineNextCheaper = findNextCheaperPeriod(schedule, now, cycle);
        const inlineNextCheaperPhrase = inlineNextCheaper ? formatRelativeStart(inlineNextCheaper.startsAt, now, TZ) : null;
        const inlineStarts = findNextStartsByKey(schedule, now, cycle);
        const inlineByKey = Object.fromEntries(
            Array.from(inlineStarts.entries()).map(([k, s]) => [k, formatRelativeStart(s, now, TZ)])
        );
        const activeEntry = cycle.find((u) => (u.touName ?? 'Unknown') === active.name && (u.buyRate ?? 0) === active.buyRate && (u.sellRate ?? 0) === active.sellRate);
        const am = activeEntry ? computeMarginalCost(activeEntry).marginalCost : null;
        const inlineActiveIsCheapest = am !== null && activeEntry
            ? cycle.every((u) => u === activeEntry || (computeMarginalCost(u).marginalCost ?? Infinity) >= am)
            : false;

        const view = computeLoadTiming(schedule, cycle, now, TZ, active);

        expect(view.nextCheaperPhrase).toEqual(inlineNextCheaperPhrase);
        expect(view.nextCheaper?.name ?? null).toEqual(inlineNextCheaper?.name ?? null);
        expect(view.nextStartPhraseByKey).toEqual(inlineByKey);
        expect(view.activeIsCheapest).toEqual(inlineActiveIsCheapest);
    });
});
