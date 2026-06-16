import { describe, it, expect } from 'vitest';
import { flatTimeline, scheduleTimeline, meteredTimeline, comparisonStructTimeline } from './plan-timeline';
import { Schedule } from '../schedule';
import type { Tariff } from '../db';

/** Build a one-season Tariff. `windows` become TariffSchedules (day 0..6, hour-aligned). */
function makeTariff(over: {
    id?: number;
    effective_from?: string | null;
    reporting_only?: boolean;
    seasonBuy?: number;
    seasonSell?: number;
    windows: Array<{ buy: number; sell: number; fromHour: number | null; toHour: number | null }>;
}): Tariff {
    return {
        id: over.id ?? 1,
        site_id: 's1',
        updated: new Date('2026-01-01T00:00:00Z'),
        name: 'T',
        reporting_only: over.reporting_only ?? false,
        effective_from: over.effective_from ?? null,
        seasons: [{
            id: 1, tariff_id: over.id ?? 1, name: 'All Year',
            from_month: 1, from_day: 1, to_month: 12, to_day: 31,
            buy_rate: over.seasonBuy ?? 0, sell_rate: over.seasonSell ?? 0,
            schedules: over.windows.map((w, i) => ({
                id: 100 + i, season_id: 1, name: `W${i}`,
                buy_rate: w.buy, sell_rate: w.sell,
                from_day_of_week: 0, to_day_of_week: 6,
                from_hour: w.fromHour, from_minute: 0, to_hour: w.toHour, to_minute: 0,
            })),
        }],
    } as Tariff;
}

const sched = (t: Tariff) => new Schedule([t], 'America/Los_Angeles');

describe('flatTimeline', () => {
    it('returns the same rate for any date and hour', () => {
        const tl = flatTimeline(0.2, 0.05);
        expect(tl.rateAt('2026-01-01', 0)).toEqual({ buy: 0.2, sell: 0.05 });
        expect(tl.rateAt('2030-12-31', 23)).toEqual({ buy: 0.2, sell: 0.05 });
    });
});

describe('scheduleTimeline — TOU bucketing', () => {
    it('prices peak vs off-peak by the hour-aligned window', () => {
        // Peak 16:00–21:00 @ buy 0.40; off-peak (all day) @ buy 0.10. Narrower window wins (Schedule sorts).
        const t = makeTariff({ windows: [
            { buy: 0.10, sell: 0.02, fromHour: null, toHour: null },   // all-day off-peak
            { buy: 0.40, sell: 0.06, fromHour: 16, toHour: 21 },        // peak
        ]});
        const tl = scheduleTimeline([{ effectiveFrom: null, schedule: sched(t) }]);
        expect(tl.rateAt('2026-07-15', 17)).toEqual({ buy: 0.40, sell: 0.06 }); // inside peak
        expect(tl.rateAt('2026-07-15', 3)).toEqual({ buy: 0.10, sell: 0.02 });  // off-peak
        expect(tl.rateAt('2026-07-15', 21)).toEqual({ buy: 0.10, sell: 0.02 }); // exclusive end
    });
});

describe('scheduleTimeline — date resolution', () => {
    const v1 = makeTariff({ id: 1, effective_from: null, windows: [{ buy: 0.10, sell: 0.01, fromHour: null, toHour: null }] });
    const v2 = makeTariff({ id: 2, effective_from: '2026-06-01', windows: [{ buy: 0.20, sell: 0.02, fromHour: null, toHour: null }] });
    const tl = scheduleTimeline([
        { effectiveFrom: null, schedule: sched(v1) },
        { effectiveFrom: '2026-06-01', schedule: sched(v2) },
    ]);

    it('uses the earliest (undated) version before the next version starts', () => {
        expect(tl.rateAt('2026-05-31', 0).buy).toBeCloseTo(0.10, 6);
    });
    it('is inclusive on effective_from', () => {
        expect(tl.rateAt('2026-06-01', 0).buy).toBeCloseTo(0.20, 6);
    });
    it('carries the latest version forward', () => {
        expect(tl.rateAt('2027-01-01', 0).buy).toBeCloseTo(0.20, 6);
    });
    it('carries the earliest version backward', () => {
        expect(tl.rateAt('2000-01-01', 0).buy).toBeCloseTo(0.10, 6);
    });
});

describe('meteredTimeline', () => {
    it('builds a timeline from non-reporting tariff versions', () => {
        const metered = makeTariff({ id: 1, reporting_only: false, windows: [{ buy: 0.33, sell: 0.03, fromHour: null, toHour: null }] });
        const reporting = makeTariff({ id: 2, reporting_only: true, windows: [{ buy: 0.99, sell: 0.09, fromHour: null, toHour: null }] });
        const tl = meteredTimeline([metered, reporting], 'America/Los_Angeles');
        expect(tl.rateAt('2026-01-01', 0)).toEqual({ buy: 0.33, sell: 0.03 }); // reporting-only excluded
    });

    it('returns zero rates when no metered tariff exists', () => {
        const tl = meteredTimeline([], 'America/Los_Angeles');
        expect(tl.rateAt('2026-01-01', 0)).toEqual({ buy: 0, sell: 0 });
    });
});

describe('comparisonStructTimeline', () => {
    it('prices a TOU comparison plan per-window (peak vs off-peak)', () => {
        const t = makeTariff({ windows: [
            { buy: 0.18, sell: 0.06, fromHour: null, toHour: null },
            { buy: 0.45, sell: 0.06, fromHour: 16, toHour: 21 },
        ]});
        const tl = comparisonStructTimeline([t], 'America/Los_Angeles');
        // 2025-01-06 is a Monday. 17:00 is peak; 03:00 is off-peak.
        expect(tl.rateAt('2025-01-06', 17).buy).toBeCloseTo(0.45, 5);
        expect(tl.rateAt('2025-01-06', 3).buy).toBeCloseTo(0.18, 5);
    });

    it('prices a degenerate one-window plan as flat (Fixed regression)', () => {
        const flat = makeTariff({ windows: [
            { buy: 0.2, sell: 0.05, fromHour: null, toHour: null },
        ]});
        const tl = comparisonStructTimeline([flat], 'America/Los_Angeles');
        expect(tl.rateAt('2025-01-06', 17).buy).toBeCloseTo(0.2, 5);
        expect(tl.rateAt('2025-07-04', 3).buy).toBeCloseTo(0.2, 5);
    });
});
