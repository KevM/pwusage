import { describe, expect, it } from 'vitest';
import { formatRelativeStart, findNextCheaperPeriod, findNextStartsByKey, periodKey } from './next-cheaper-period';
import type { UsageData } from './energy-repo';
import { Schedule, type TariffPeriod } from './schedule';
import type { Tariff } from './db';

describe('formatRelativeStart', () => {
    const tz = 'America/Los_Angeles';

    it('renders same-day starts as "today at H AM/PM"', () => {
        // Both in LA timezone on March 15, 2026 (PDT, UTC-7).
        const now = new Date(Date.UTC(2026, 2, 15, 18, 0, 0)); // 11 AM LA
        const start = new Date(Date.UTC(2026, 2, 16, 3, 0, 0)); // 8 PM LA same day
        expect(formatRelativeStart(start, now, tz)).toBe('today at 8 PM');
    });

    it('renders next-day starts as "tomorrow at H AM/PM"', () => {
        const now = new Date(Date.UTC(2026, 2, 15, 22, 0, 0)); // 3 PM LA Mar 15
        const start = new Date(Date.UTC(2026, 2, 16, 13, 0, 0)); // 6 AM LA Mar 16
        expect(formatRelativeStart(start, now, tz)).toBe('tomorrow at 6 AM');
    });

    it('renders within-week starts with weekday', () => {
        // Sunday Mar 15 → Friday Mar 20 within the week.
        const now = new Date(Date.UTC(2026, 2, 15, 18, 0, 0)); // 11 AM LA Sun
        const start = new Date(Date.UTC(2026, 2, 20, 15, 0, 0)); // 8 AM LA Fri
        expect(formatRelativeStart(start, now, tz)).toBe('Friday at 8 AM');
    });

    it('renders further-out starts with month + day', () => {
        const now = new Date(Date.UTC(2026, 2, 15, 18, 0, 0)); // Mar 15
        const start = new Date(Date.UTC(2026, 2, 25, 15, 0, 0)); // Mar 25
        expect(formatRelativeStart(start, now, tz)).toBe('Mar 25 at 8 AM');
    });

    it('preserves minutes when not on the hour', () => {
        const now = new Date(Date.UTC(2026, 2, 15, 18, 0, 0));
        const start = new Date(Date.UTC(2026, 2, 16, 3, 30, 0)); // 8:30 PM LA same day
        expect(formatRelativeStart(start, now, tz)).toBe('today at 8:30 PM');
    });
});

// Minimal stub returning a (distinct-id'd) period for any timestamp in its
// [start, end] window. Periods must not overlap. Used by walker-agnostic tests.
function makeStubSchedule(periods: TariffPeriod[]): Schedule {
    const stub = {
        getTariffPeriod(t: Date): TariffPeriod | null {
            for (const p of periods) {
                if (t >= p.start && t <= p.end) return p;
            }
            return null;
        }
    };
    return stub as unknown as Schedule;
}

function makePeriod(scheduleId: number, name: string, buyRate: number, sellRate: number, start: Date, end: Date): TariffPeriod {
    return {
        start,
        end,
        tariff: { id: 1, site_id: 's', updated: new Date(), name: 'Tariff' },
        season: { id: 1, tariff_id: 1, name: 'Season', from_month: 1, from_day: 1, to_month: 12, to_day: 31, buy_rate: buyRate, sell_rate: sellRate },
        schedule: { id: scheduleId, season_id: 1, name, buy_rate: buyRate, sell_rate: sellRate, from_day_of_week: null, from_hour: null, from_minute: null, to_day_of_week: null, to_hour: null, to_minute: null }
    };
}

function makeUsage(name: string, buyRate: number, sellRate: number, gridUsage: number): UsageData {
    return {
        start: new Date(),
        homeUsage: 0,
        gridUsage,
        solarProduction: 0,
        batteryChange: 0,
        tariff: { id: 1, site_id: 's', updated: new Date(), name: 'Tariff' },
        touName: name,
        buyRate,
        sellRate,
        cost: 0
    };
}

describe('findNextCheaperPeriod', () => {
    it('returns the next period whose marginal cost is lower than active', () => {
        const t0 = new Date(Date.UTC(2026, 2, 15, 18, 0, 0)); // 18:00 UTC
        const onPeak = makePeriod(/*id*/ 100, 'On-Peak', 0.30, 0.03,
            new Date(Date.UTC(2026, 2, 15, 16, 0, 0)),
            new Date(Date.UTC(2026, 2, 15, 23, 59, 59, 999)));
        const offPeak = makePeriod(/*id*/ 200, 'Off-Peak', 0.10, 0.03,
            new Date(Date.UTC(2026, 2, 16, 0, 0, 0)),
            new Date(Date.UTC(2026, 2, 16, 15, 59, 59, 999)));

        const schedule = makeStubSchedule([onPeak, offPeak]);
        const cycle: UsageData[] = [
            makeUsage('On-Peak', 0.30, 0.03, 1_000_000),   // net importer → buy → 0.30
            makeUsage('Off-Peak', 0.10, 0.03, -50_000)     // net exporter → sell → 0.03
        ];

        const result = findNextCheaperPeriod(schedule, t0, cycle, 48);
        expect(result).not.toBeNull();
        expect(result!.name).toBe('Off-Peak');
        expect(result!.marginalCost).toBeCloseTo(0.03);
        expect(result!.basis).toBe('sell');
        // Walker detects the schedule.id change and refines to the boundary minute.
        expect(result!.startsAt).toEqual(new Date(Date.UTC(2026, 2, 16, 0, 0, 0)));
    });

    it('returns null when active period is already the cheapest', () => {
        const t0 = new Date(Date.UTC(2026, 2, 15, 1, 0, 0));
        const offPeak = makePeriod(100, 'Off-Peak', 0.10, 0.03,
            new Date(Date.UTC(2026, 2, 15, 0, 0, 0)),
            new Date(Date.UTC(2026, 2, 15, 15, 59, 59, 999)));
        const onPeak = makePeriod(200, 'On-Peak', 0.30, 0.03,
            new Date(Date.UTC(2026, 2, 15, 16, 0, 0)),
            new Date(Date.UTC(2026, 2, 15, 23, 59, 59, 999)));

        const schedule = makeStubSchedule([offPeak, onPeak]);
        const cycle: UsageData[] = [
            makeUsage('Off-Peak', 0.10, 0.03, -200_000),  // net exporter → 0.03
            makeUsage('On-Peak', 0.30, 0.03, 100_000)     // net importer → 0.30
        ];

        const result = findNextCheaperPeriod(schedule, t0, cycle, 48);
        expect(result).toBeNull();
    });

    it('returns null when active period has no resolvable marginal cost', () => {
        const t0 = new Date(Date.UTC(2026, 2, 15, 18, 0, 0));
        const onPeak = makePeriod(100, 'On-Peak', 0.30, 0.03,
            new Date(Date.UTC(2026, 2, 15, 16, 0, 0)),
            new Date(Date.UTC(2026, 2, 16, 0, 0, 0)));
        const schedule = makeStubSchedule([onPeak]);
        const cycle: UsageData[] = [
            makeUsage('On-Peak', 0.30, 0.03, 100)  // |0.1 kWh| < 0.5 → neutral
        ];

        const result = findNextCheaperPeriod(schedule, t0, cycle, 48);
        expect(result).toBeNull();
    });

    it('returns null when no current period at now (gap)', () => {
        const schedule = makeStubSchedule([]);
        const t0 = new Date();
        expect(findNextCheaperPeriod(schedule, t0, [], 48)).toBeNull();
    });
});

describe('findNextStartsByKey', () => {
    it('returns the next start for each non-active period in the cycle', () => {
        // Walker should detect each schedule.id transition and record the
        // local-hour-aligned start of the new period for that key.
        const t0 = new Date(Date.UTC(2026, 2, 15, 18, 0, 0)); // 18:00 UTC, active = Off-Peak
        const offPeakA = makePeriod(100, 'Off-Peak', 0.10, 0.03,
            new Date(Date.UTC(2026, 2, 15, 7, 0, 0)),
            new Date(Date.UTC(2026, 2, 15, 19, 59, 59, 999)));
        const onPeak = makePeriod(200, 'On-Peak', 0.30, 0.03,
            new Date(Date.UTC(2026, 2, 15, 20, 0, 0)),
            new Date(Date.UTC(2026, 2, 15, 23, 59, 59, 999)));
        const offPeakB = makePeriod(300, 'Off-Peak', 0.10, 0.03,
            new Date(Date.UTC(2026, 2, 16, 0, 0, 0)),
            new Date(Date.UTC(2026, 2, 16, 19, 59, 59, 999)));
        const schedule = makeStubSchedule([offPeakA, onPeak, offPeakB]);
        const cycle: UsageData[] = [
            makeUsage('Off-Peak', 0.10, 0.03, -50_000),
            makeUsage('On-Peak', 0.30, 0.03, 100_000)
        ];

        const result = findNextStartsByKey(schedule, t0, cycle);
        // On-Peak first occurs at 20:00 UTC the same day.
        expect(result.get(periodKey('On-Peak')))
            .toEqual(new Date(Date.UTC(2026, 2, 15, 20, 0, 0)));
        // Off-Peak (the active key) re-occurs the next day at 00:00 UTC.
        expect(result.get(periodKey('Off-Peak')))
            .toEqual(new Date(Date.UTC(2026, 2, 16, 0, 0, 0)));
    });

    it('records only the earliest future occurrence per key', () => {
        const t0 = new Date(Date.UTC(2026, 2, 15, 18, 0, 0));
        const active = makePeriod(100, 'Off-Peak', 0.10, 0.03,
            new Date(Date.UTC(2026, 2, 15, 7, 0, 0)),
            new Date(Date.UTC(2026, 2, 15, 19, 59, 59, 999)));
        const firstOnPeak = makePeriod(200, 'On-Peak', 0.30, 0.03,
            new Date(Date.UTC(2026, 2, 15, 20, 0, 0)),
            new Date(Date.UTC(2026, 2, 15, 23, 59, 59, 999)));
        const offPeakB = makePeriod(300, 'Off-Peak', 0.10, 0.03,
            new Date(Date.UTC(2026, 2, 16, 0, 0, 0)),
            new Date(Date.UTC(2026, 2, 16, 19, 59, 59, 999)));
        const laterOnPeak = makePeriod(400, 'On-Peak', 0.30, 0.03,
            new Date(Date.UTC(2026, 2, 16, 20, 0, 0)),
            new Date(Date.UTC(2026, 2, 16, 23, 59, 59, 999)));

        const schedule = makeStubSchedule([active, firstOnPeak, offPeakB, laterOnPeak]);
        const cycle: UsageData[] = [
            makeUsage('Off-Peak', 0.10, 0.03, -50_000),
            makeUsage('On-Peak', 0.30, 0.03, 100_000)
        ];

        const result = findNextStartsByKey(schedule, t0, cycle);
        expect(result.get(periodKey('On-Peak')))
            .toEqual(new Date(Date.UTC(2026, 2, 15, 20, 0, 0)));
    });

    it('returns empty map when no active period at now', () => {
        const schedule = makeStubSchedule([]);
        const result = findNextStartsByKey(schedule, new Date(), []);
        expect(result.size).toBe(0);
    });
});

// Integration test against a real Schedule: regression coverage for the bug
// where Schedule.getTariffPeriod returns start=end=query-time. The previous
// walker advanced by `cursor.end + 1ms` and never crossed period boundaries,
// causing findNextCheaperPeriod to always return null in production.
describe('walker against real Schedule (regression)', () => {
    function buildTariff(): Tariff {
        return {
            id: 1,
            site_id: 'site-1',
            updated: new Date(),
            name: 'PG&E EV2-A',
            seasons: [
                {
                    id: 1,
                    tariff_id: 1,
                    name: 'Year-round',
                    from_month: 1, from_day: 1,
                    to_month: 12, to_day: 31,
                    buy_rate: 0,
                    sell_rate: 0,
                    schedules: [
                        // Tesla weekday encoding: 0=Mon..6=Sun. "Every day" is from=0 to=6.
                        // On-Peak: 16:00–21:00 every day.
                        { id: 10, season_id: 1, name: 'On-Peak', buy_rate: 0.45, sell_rate: 0.04,
                            from_day_of_week: 0, to_day_of_week: 6,
                            from_hour: 16, to_hour: 21, from_minute: 0, to_minute: 0 },
                        // Off-Peak default: catch-all for the rest of the day.
                        { id: 20, season_id: 1, name: 'Off-Peak', buy_rate: 0.10, sell_rate: 0.04,
                            from_day_of_week: 0, to_day_of_week: 6,
                            from_hour: null, to_hour: null, from_minute: null, to_minute: null }
                    ]
                }
            ]
        };
    }

    it('finds the next cheaper period when active is On-Peak (net importer)', () => {
        const schedule = new Schedule([buildTariff()], 'America/Los_Angeles');
        // 5 PM LA on Mar 16, 2026 (PDT, UTC-7) = 00:00 UTC Mar 17.
        const now = new Date(Date.UTC(2026, 2, 17, 0, 0, 0));
        // Verify active is On-Peak before testing.
        expect(schedule.getTariffPeriod(now)?.schedule.name).toBe('On-Peak');

        const cycle: UsageData[] = [
            // On-Peak net importer → marginal $0.45 (buy basis)
            makeUsage('On-Peak', 0.45, 0.04, 200_000),
            // Off-Peak net importer → marginal $0.10 (buy basis)
            makeUsage('Off-Peak', 0.10, 0.04, 500_000)
        ];

        const result = findNextCheaperPeriod(schedule, now, cycle, 48);
        expect(result).not.toBeNull();
        expect(result!.name).toBe('Off-Peak');
        expect(result!.marginalCost).toBeCloseTo(0.10);
        // On-Peak ends at 21:00 LA, so the next Off-Peak starts at 9 PM LA.
        // 21:00 LA on Mar 16 (PDT) = 04:00 UTC Mar 17.
        expect(result!.startsAt).toEqual(new Date(Date.UTC(2026, 2, 17, 4, 0, 0)));
    });

    it('finds the next On-Peak start when active is Off-Peak', () => {
        const schedule = new Schedule([buildTariff()], 'America/Los_Angeles');
        // 10 AM LA Mar 16 = 17:00 UTC Mar 16.
        const now = new Date(Date.UTC(2026, 2, 16, 17, 0, 0));
        expect(schedule.getTariffPeriod(now)?.schedule.name).toBe('Off-Peak');

        const cycle: UsageData[] = [
            makeUsage('On-Peak', 0.45, 0.04, 200_000),
            makeUsage('Off-Peak', 0.10, 0.04, -200_000) // net exporter, marginal $0.04
        ];

        const result = findNextStartsByKey(schedule, now, cycle);
        // Next On-Peak starts at 4 PM LA same day = 23:00 UTC Mar 16.
        expect(result.get(periodKey('On-Peak')))
            .toEqual(new Date(Date.UTC(2026, 2, 16, 23, 0, 0)));
    });
});

describe('walker with minute-granularity boundaries (real Schedule)', () => {
    // On-Peak starts on the half hour — 16:30–21:00 daily. The old hourly
    // walker snapped the reported start to the enclosing hour of whichever
    // cursor detected the change, so the same boundary was reported as 16:00
    // or 17:00 depending on the current wall-clock minute.
    function buildHalfHourTariff(): Tariff {
        return {
            id: 2, site_id: 'site-2', updated: new Date(), name: 'Half-Hour',
            seasons: [{
                id: 21, tariff_id: 2, name: 'All Year',
                from_month: 1, from_day: 1, to_month: 12, to_day: 31,
                buy_rate: 0, sell_rate: 0,
                schedules: [
                    { id: 210, season_id: 21, name: 'On-Peak', buy_rate: 0.45, sell_rate: 0.04,
                        from_day_of_week: 0, to_day_of_week: 6,
                        from_hour: 16, from_minute: 30, to_hour: 21, to_minute: 0 },
                    { id: 220, season_id: 21, name: 'Off-Peak', buy_rate: 0.10, sell_rate: 0.04,
                        from_day_of_week: 0, to_day_of_week: 6,
                        from_hour: null, from_minute: null, to_hour: null, to_minute: null }
                ]
            }]
        };
    }

    const halfHourCycle: UsageData[] = [
        makeUsage('On-Peak', 0.45, 0.04, 200_000),
        makeUsage('Off-Peak', 0.10, 0.04, 500_000)
    ];

    it('reports a 16:30 boundary exactly when the old walker snapped early', () => {
        const schedule = new Schedule([buildHalfHourTariff()], 'America/Los_Angeles');
        // now = 14:45 PDT Mar 16 2026 (21:45 UTC): hourly cursors landed at
        // 16:45 and snapped to 16:00 — half an hour before On-Peak begins.
        const now = new Date(Date.UTC(2026, 2, 16, 21, 45, 0));
        const starts = findNextStartsByKey(schedule, now, halfHourCycle, 24);
        // True boundary: 16:30 PDT = 23:30 UTC.
        expect(starts.get(periodKey('On-Peak'))).toEqual(new Date(Date.UTC(2026, 2, 16, 23, 30, 0)));
    });

    it('reports a 16:30 boundary exactly when the old walker snapped late', () => {
        const schedule = new Schedule([buildHalfHourTariff()], 'America/Los_Angeles');
        // now = 14:15 PDT: hourly cursors landed at 17:15 and snapped to 17:00.
        const now = new Date(Date.UTC(2026, 2, 16, 21, 15, 0));
        const starts = findNextStartsByKey(schedule, now, halfHourCycle, 24);
        expect(starts.get(periodKey('On-Peak'))).toEqual(new Date(Date.UTC(2026, 2, 16, 23, 30, 0)));
    });

    it('detects a 30-minute period the hourly walker skipped entirely', () => {
        const superPeakTariff: Tariff = {
            id: 4, site_id: 'site-4', updated: new Date(), name: 'Super',
            seasons: [{
                id: 41, tariff_id: 4, name: 'All Year',
                from_month: 1, from_day: 1, to_month: 12, to_day: 31,
                buy_rate: 0, sell_rate: 0,
                schedules: [
                    { id: 410, season_id: 41, name: 'Super-Peak', buy_rate: 0.60, sell_rate: 0.04,
                        from_day_of_week: 0, to_day_of_week: 6,
                        from_hour: 17, from_minute: 0, to_hour: 17, to_minute: 30 },
                    { id: 420, season_id: 41, name: 'Off-Peak', buy_rate: 0.10, sell_rate: 0.04,
                        from_day_of_week: 0, to_day_of_week: 6,
                        from_hour: null, from_minute: null, to_hour: null, to_minute: null }
                ]
            }]
        };
        const schedule = new Schedule([superPeakTariff], 'America/Los_Angeles');
        const now = new Date(Date.UTC(2026, 2, 16, 21, 45, 0)); // 14:45 PDT
        const cycle: UsageData[] = [
            makeUsage('Super-Peak', 0.60, 0.04, 100_000),
            makeUsage('Off-Peak', 0.10, 0.04, 500_000)
        ];
        const starts = findNextStartsByKey(schedule, now, cycle, 24);
        // 17:00 PDT Mar 16 = 00:00 UTC Mar 17.
        expect(starts.get(periodKey('Super-Peak'))).toEqual(new Date(Date.UTC(2026, 2, 17, 0, 0, 0)));
    });
});

describe('findNextCheaperPeriod – season-level rates (null schedule rates)', () => {
    // The ScheduleEditor can store rates on the season with null schedule
    // rates. load-timing patches cycle rates with the season fallback, but the
    // transition cost used `t.schedule.buy_rate ?? 0` — pricing every future
    // period at $0 and reporting a bogus "cheaper period" on a flat tariff.
    function buildSeasonRateTariff(): Tariff {
        return {
            id: 3, site_id: 'site-3', updated: new Date(), name: 'Flat',
            seasons: [{
                id: 31, tariff_id: 3, name: 'All Year',
                from_month: 1, from_day: 1, to_month: 12, to_day: 31,
                buy_rate: 0.25, sell_rate: 0.04,
                schedules: [
                    { id: 310, season_id: 31, name: 'On-Peak', buy_rate: null, sell_rate: null,
                        from_day_of_week: 0, to_day_of_week: 6,
                        from_hour: 16, from_minute: 0, to_hour: 21, to_minute: 0 },
                    { id: 320, season_id: 31, name: 'Off-Peak', buy_rate: null, sell_rate: null,
                        from_day_of_week: 0, to_day_of_week: 6,
                        from_hour: null, from_minute: null, to_hour: null, to_minute: null }
                ]
            }]
        };
    }

    it('falls back to season rates instead of pricing transitions at $0', () => {
        const schedule = new Schedule([buildSeasonRateTariff()], 'America/Los_Angeles');
        const now = new Date(Date.UTC(2026, 2, 16, 17, 0, 0)); // 10:00 PDT, Off-Peak
        expect(schedule.getTariffPeriod(now)?.schedule.name).toBe('Off-Peak');
        // Cycle entries arrive with season-patched rates (computeLoadTiming
        // applies `s.buy_rate ?? season.buy_rate` before calling us).
        const cycle: UsageData[] = [
            makeUsage('Off-Peak', 0.25, 0.04, 500_000),
            makeUsage('On-Peak', 0.25, 0.04, 500_000)
        ];
        // Effectively a flat tariff: nothing is cheaper than the active 0.25.
        expect(findNextCheaperPeriod(schedule, now, cycle, 48)).toBeNull();
    });
});
