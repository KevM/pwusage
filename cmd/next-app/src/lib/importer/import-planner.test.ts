import { describe, it, expect } from 'vitest';
import { planImport, selectWindows, splitAtSiteMidnight, auditDays, generateDayWindows } from './import-planner';
import type { PlannedWindow } from './import-planner';
import { formatSiteDate } from '../date-utils';
import type { DailyCoverageStat } from '../energy-repo';

// America/Chicago is UTC-6 in winter, so site midnight = 06:00 UTC
const TZ = 'America/Chicago';
const DAY1_START = new Date('2026-01-10T06:00:00.000Z'); // midnight Chicago
const DAY1_END = new Date('2026-01-11T06:00:00.000Z');   // midnight next day
const FUTURE = new Date('2026-01-12T12:00:00.000Z');
const DAY1_KEY = '2026-01-10';
const THIRTY_MIN = 30 * 60 * 1000;

function fiveMinTicks(from: Date, to: Date): number[] {
    const ticks: number[] = [];
    let t = from.getTime();
    while (t < to.getTime()) {
        ticks.push(t);
        t += 5 * 60 * 1000;
    }
    return ticks;
}

/**
 * Test-side mirror of `EnergyRepo.getDailyCoverage`: buckets epoch-ms ticks by
 * their site-local day and reports the same per-day scalars the SQL computes.
 * `maxInteriorGapMs` is the largest delta between consecutive samples of that
 * day, threshold-independently — matching the SQL, where each day's first row
 * contributes a zero-second gap via `COALESCE(prev_ts, timestamp)` and so can
 * never win the `MAX`. A single-tick day therefore yields 0, not NaN.
 */
function coverageFromTicks(ticks: number[], tz: string): DailyCoverageStat[] {
    const byDay = new Map<string, number[]>();
    for (const t of [...ticks].sort((a, b) => a - b)) {
        const key = formatSiteDate(new Date(t), tz);
        const bucket = byDay.get(key);
        if (bucket) {
            bucket.push(t);
        } else {
            byDay.set(key, [t]);
        }
    }

    return [...byDay.entries()].map(([localDayKey, dayTicks]) => {
        let maxInteriorGapMs = 0;
        for (let i = 1; i < dayTicks.length; i++) {
            maxInteriorGapMs = Math.max(maxInteriorGapMs, dayTicks[i] - dayTicks[i - 1]);
        }
        return {
            localDayKey,
            count: dayTicks.length,
            first: new Date(dayTicks[0]),
            last: new Date(dayTicks[dayTicks.length - 1]),
            maxInteriorGapMs,
        };
    });
}

/**
 * A hand-written fully covered day for the threshold cases, where only one
 * scalar should vary. `count` is a plausible dense-day value and is not what
 * these cases exercise — the audit only reads it to detect an entirely empty
 * day, which the "no stored coverage" cases below cover instead.
 */
function coveredDay(overrides: Partial<DailyCoverageStat> = {}): DailyCoverageStat {
    return {
        localDayKey: DAY1_KEY,
        count: 288,
        first: DAY1_START,
        last: new Date(DAY1_END.getTime() - 5 * 60 * 1000),
        maxInteriorGapMs: 5 * 60 * 1000,
        ...overrides,
    };
}

describe('planImport', () => {
    it('returns a window for a day with no existing data', () => {
        const result = planImport({
            requestedRange: { start: DAY1_START, end: DAY1_END },
            existingCoverage: [],
            timezone: TZ,
            now: FUTURE,
        });
        expect(result).toHaveLength(1);
    });

    it('returns no windows when day is fully covered', () => {
        const result = planImport({
            requestedRange: { start: DAY1_START, end: DAY1_END },
            existingCoverage: coverageFromTicks(fiveMinTicks(DAY1_START, DAY1_END), TZ),
            timezone: TZ,
            now: FUTURE,
        });
        expect(result).toHaveLength(0);
    });

    it('returns a window when gap at start exceeds threshold', () => {
        // Only one point, 1 hour into the day — gap at start
        const result = planImport({
            requestedRange: { start: DAY1_START, end: DAY1_END },
            existingCoverage: coverageFromTicks([DAY1_START.getTime() + 60 * 60 * 1000], TZ),
            timezone: TZ,
            now: FUTURE,
        });
        expect(result).toHaveLength(1);
    });

    it('returns a window when gap at end exceeds threshold', () => {
        // Only one point, 1 hour before end of day — gap at end
        const result = planImport({
            requestedRange: { start: DAY1_START, end: DAY1_END },
            existingCoverage: coverageFromTicks([DAY1_END.getTime() - 60 * 60 * 1000], TZ),
            timezone: TZ,
            now: FUTURE,
        });
        expect(result).toHaveLength(1);
    });

    it('returns a window when there is an interior gap', () => {
        // Points at start and end of day, but a huge gap in the middle
        const ticks = [
            DAY1_START.getTime() + 5 * 60 * 1000,
            DAY1_END.getTime() - 5 * 60 * 1000,
        ];
        const result = planImport({
            requestedRange: { start: DAY1_START, end: DAY1_END },
            existingCoverage: coverageFromTicks(ticks, TZ),
            timezone: TZ,
            now: FUTURE,
        });
        expect(result).toHaveLength(1);
    });

    it('returns window even when fully covered if forceRefetch is true', () => {
        const result = planImport({
            requestedRange: { start: DAY1_START, end: DAY1_END },
            existingCoverage: coverageFromTicks(fiveMinTicks(DAY1_START, DAY1_END), TZ),
            timezone: TZ,
            forceRefetch: true,
            now: FUTURE,
        });
        expect(result).toHaveLength(1);
    });

    it('clamps start to installationDate', () => {
        const result = planImport({
            requestedRange: { start: new Date('2026-01-01T06:00:00.000Z'), end: DAY1_END },
            existingCoverage: [],
            timezone: TZ,
            installationDate: DAY1_START,
            now: FUTURE,
        });
        expect(result.map(w => w.start.getTime())).toEqual([DAY1_START.getTime()]);
    });

    it('returns two windows for two days each missing data', () => {
        const DAY2_END = new Date('2026-01-12T06:00:00.000Z');
        const result = planImport({
            requestedRange: { start: DAY1_START, end: DAY2_END },
            existingCoverage: [],
            timezone: TZ,
            now: FUTURE,
        });
        expect(result).toHaveLength(2);
    });
});

describe('planImport — days with no stored coverage', () => {
    const EXPECTED = [{ start: DAY1_START, end: DAY1_END }];

    it('re-fetches a day with no entry in existingCoverage', () => {
        const result = planImport({
            requestedRange: { start: DAY1_START, end: DAY1_END },
            existingCoverage: [],
            timezone: TZ,
            now: FUTURE,
        });
        expect(result).toEqual(EXPECTED);
    });

    it('re-fetches a day with an explicit zero-count entry', () => {
        // The SQL emits no row for a day with zero samples, so this shape is
        // defensive — but it must behave identically to a missing entry.
        const result = planImport({
            requestedRange: { start: DAY1_START, end: DAY1_END },
            existingCoverage: [{
                localDayKey: DAY1_KEY,
                count: 0,
                first: null,
                last: null,
                maxInteriorGapMs: 0,
            }],
            timezone: TZ,
            now: FUTURE,
        });
        expect(result).toEqual(EXPECTED);
    });
});

describe('planImport — interior gap threshold', () => {
    it('plans no re-import for a 29-minute max interior gap', () => {
        const result = planImport({
            requestedRange: { start: DAY1_START, end: DAY1_END },
            existingCoverage: [coveredDay({ maxInteriorGapMs: THIRTY_MIN - 60 * 1000 })],
            timezone: TZ,
            now: FUTURE,
        });
        expect(result).toEqual([]);
    });

    it('plans a re-import for a 31-minute max interior gap', () => {
        const result = planImport({
            requestedRange: { start: DAY1_START, end: DAY1_END },
            existingCoverage: [coveredDay({ maxInteriorGapMs: THIRTY_MIN + 60 * 1000 })],
            timezone: TZ,
            now: FUTURE,
        });
        expect(result).toEqual([{ start: DAY1_START, end: DAY1_END }]);
    });
});

describe('planImport — a gap exactly equal to the threshold is not a gap', () => {
    it('does not flag missingStart for a first sample exactly 30 minutes late', () => {
        const coverage = [coveredDay({ first: new Date(DAY1_START.getTime() + THIRTY_MIN) })];
        const days = auditDays({
            requestedRange: { start: DAY1_START, end: DAY1_END },
            existingCoverage: coverage,
            timezone: TZ,
            now: FUTURE,
        });
        expect(days[0].missingStart).toBe(false);
        expect(planImport({
            requestedRange: { start: DAY1_START, end: DAY1_END },
            existingCoverage: coverage,
            timezone: TZ,
            now: FUTURE,
        })).toEqual([]);
    });

    it('does not flag missingEnd for a last sample exactly 30 minutes early', () => {
        const coverage = [coveredDay({ last: new Date(DAY1_END.getTime() - THIRTY_MIN) })];
        const days = auditDays({
            requestedRange: { start: DAY1_START, end: DAY1_END },
            existingCoverage: coverage,
            timezone: TZ,
            now: FUTURE,
        });
        expect(days[0].missingEnd).toBe(false);
        expect(planImport({
            requestedRange: { start: DAY1_START, end: DAY1_END },
            existingCoverage: coverage,
            timezone: TZ,
            now: FUTURE,
        })).toEqual([]);
    });

    it('does not flag hasInteriorGap for a max interior gap of exactly 30 minutes', () => {
        const coverage = [coveredDay({ maxInteriorGapMs: THIRTY_MIN })];
        const days = auditDays({
            requestedRange: { start: DAY1_START, end: DAY1_END },
            existingCoverage: coverage,
            timezone: TZ,
            now: FUTURE,
        });
        expect(days[0].hasInteriorGap).toBe(false);
        expect(planImport({
            requestedRange: { start: DAY1_START, end: DAY1_END },
            existingCoverage: coverage,
            timezone: TZ,
            now: FUTURE,
        })).toEqual([]);
    });
});

describe('planImport — settled archive days', () => {
    // A trimmed day Tesla never fully reported: archive metadata shows a 2-hour hole.
    const holeyArchive: DailyCoverageStat = {
        localDayKey: DAY1_KEY,
        count: 264,
        first: DAY1_START,
        last: new Date(DAY1_END.getTime() - 5 * 60 * 1000),
        maxInteriorGapMs: 2 * 60 * 60 * 1000,
        archived: true,
    };

    it('treats a settled archive day as covered even when its samples have gaps', () => {
        expect(planImport({
            requestedRange: { start: DAY1_START, end: DAY1_END },
            existingCoverage: [holeyArchive],
            timezone: TZ,
            now: FUTURE,
        })).toEqual([]);
    });

    it('still re-fetches the same gap when the day is not a settled archive', () => {
        expect(planImport({
            requestedRange: { start: DAY1_START, end: DAY1_END },
            existingCoverage: [{ ...holeyArchive, archived: false }],
            timezone: TZ,
            now: FUTURE,
        })).toHaveLength(1);
    });

    it('re-fetches a settled archive day when forced', () => {
        expect(planImport({
            requestedRange: { start: DAY1_START, end: DAY1_END },
            existingCoverage: [holeyArchive],
            timezone: TZ,
            forceRefetch: true,
            now: FUTURE,
        })).toEqual([{ start: DAY1_START, end: DAY1_END }]);
    });

    it('reports the settled flag in the audit', () => {
        const [day] = auditDays({
            requestedRange: { start: DAY1_START, end: DAY1_END },
            existingCoverage: [holeyArchive],
            timezone: TZ,
            now: FUTURE,
        });
        expect(day).toMatchObject({ archived: true, hasInteriorGap: true });
    });
});

describe('planImport — empty days', () => {
    const DAY2_START = DAY1_END;
    const DAY2_END = new Date('2026-01-12T06:00:00.000Z');
    const LATER = new Date('2026-02-20T12:00:00.000Z');
    const CHECKED = new Date('2026-01-12T07:00:00.000Z');

    it('skips a day Tesla settled as empty, and still fetches other missing days', () => {
        expect(planImport({
            requestedRange: { start: DAY1_START, end: DAY2_END },
            existingCoverage: [],
            timezone: TZ,
            emptyDays: [{ dayStart: DAY1_START, fetchedAt: CHECKED, settled: true }],
            now: LATER,
        })).toEqual([{ start: DAY2_START, end: DAY2_END }]);
    });

    it('re-fetches a settled empty day when forced', () => {
        expect(planImport({
            requestedRange: { start: DAY1_START, end: DAY1_END },
            existingCoverage: [],
            timezone: TZ,
            emptyDays: [{ dayStart: DAY1_START, fetchedAt: CHECKED, settled: true }],
            forceRefetch: true,
            now: LATER,
        })).toEqual([{ start: DAY1_START, end: DAY1_END }]);
    });

    it('retries an unsettled empty day, carrying when it was last checked', () => {
        expect(planImport({
            requestedRange: { start: DAY1_START, end: DAY1_END },
            existingCoverage: [],
            timezone: TZ,
            emptyDays: [{ dayStart: DAY1_START, fetchedAt: CHECKED, settled: false }],
            now: FUTURE,
        })).toEqual([{ start: DAY1_START, end: DAY1_END, fetchedAt: CHECKED }]);
    });
});

describe('selectWindows', () => {
    const day = (n: number, extra: Partial<PlannedWindow> = {}): PlannedWindow =>
        ({ start: new Date(+DAY1_START + n * 86400000), end: new Date(+DAY1_START + (n + 1) * 86400000), ...extra });
    const at = (hour: number) => new Date(Date.UTC(2026, 0, 20, hour));
    const starts = (w: PlannedWindow[]) => w.map(x => Math.round((+x.start - +DAY1_START) / 86400000));

    it('keeps every window, oldest first, without a cap', () => {
        const windows = [day(0), day(1, { openRetry: true }), day(2)];
        expect(selectWindows(windows, undefined)).toBe(windows);
    });

    it('takes never-fetched days newest first, then fetched days least recently fetched first, open retries last', () => {
        const windows = [day(0, { fetchedAt: at(3) }), day(1), day(2, { fetchedAt: at(1) }), day(3, { openRetry: true, fetchedAt: at(0) }), day(4)];
        expect(starts(selectWindows(windows, 5))).toEqual([4, 1, 2, 0, 3]);
    });

    it('rotates through more retries than the cap as each fetch moves its day to the back', () => {
        // Four open records Tesla keeps answering the same way, three windows per run.
        let windows = [0, 1, 2, 3].map(n => day(n, { openRetry: true, fetchedAt: at(0) }));
        const served = new Set<number>();
        for (let run = 1; run <= 2; run++) {
            const chosen = selectWindows(windows, 3);
            starts(chosen).forEach(n => served.add(n));
            const refetched = new Set(chosen);
            windows = windows.map(w => refetched.has(w) ? { ...w, fetchedAt: at(run) } : w);
        }
        expect([...served].sort()).toEqual([0, 1, 2, 3]);
    });
});

describe('splitAtSiteMidnight', () => {
    it('returns a single window that does not cross site midnight', () => {
        const w = {
            start: new Date('2026-01-10T06:00:00.000Z'),
            end: new Date('2026-01-10T20:00:00.000Z'),
        };
        expect(splitAtSiteMidnight(w, TZ)).toHaveLength(1);
    });

    it('splits a window crossing site midnight into two chunks', () => {
        const w = {
            start: new Date('2026-01-10T20:00:00.000Z'),
            end: new Date('2026-01-11T12:00:00.000Z'),
        };
        const result = splitAtSiteMidnight(w, TZ);
        expect(result).toHaveLength(2);
        expect(result[0].end.getTime()).toBe(DAY1_END.getTime()); // Jan 11 midnight Chicago = Jan 11 06:00 UTC
        expect(result[1].start.getTime()).toBe(DAY1_END.getTime());
    });

    it('preserves start and end of the original window across chunks', () => {
        const start = new Date('2026-01-10T20:00:00.000Z');
        const end = new Date('2026-01-11T12:00:00.000Z');
        const result = splitAtSiteMidnight({ start, end }, TZ);
        expect(result[0].start.getTime()).toBe(start.getTime());
        expect(result[result.length - 1].end.getTime()).toBe(end.getTime());
    });

    it('splits a 48h window into three chunks', () => {
        const w = {
            start: new Date('2026-01-10T00:00:00.000Z'),
            end: new Date('2026-01-12T00:00:00.000Z'),
        };
        expect(splitAtSiteMidnight(w, TZ)).toHaveLength(3);
    });
});

describe('auditDays', () => {
    it('returns one result per day in range', () => {
        const DAY2_END = new Date('2026-01-12T06:00:00.000Z');
        const results = auditDays({
            requestedRange: { start: DAY1_START, end: DAY2_END },
            existingCoverage: [],
            timezone: TZ,
            now: FUTURE,
        });
        expect(results).toHaveLength(2);
    });

    it('reports count and first/last for a covered day', () => {
        const ticks = fiveMinTicks(DAY1_START, DAY1_END);
        const results = auditDays({
            requestedRange: { start: DAY1_START, end: DAY1_END },
            existingCoverage: coverageFromTicks(ticks, TZ),
            timezone: TZ,
            now: FUTURE,
        });
        expect(results[0].count).toBe(ticks.length);
        expect(results[0].firstInWindow).toBe(DAY1_START.getTime());
        expect(results[0].lastInWindow).toBe(DAY1_END.getTime() - 5 * 60 * 1000);
        expect(results[0].missingStart).toBe(false);
        expect(results[0].missingEnd).toBe(false);
        expect(results[0].hasInteriorGap).toBe(false);
    });

    it('flags missingStart when gap at beginning exceeds threshold', () => {
        const results = auditDays({
            requestedRange: { start: DAY1_START, end: DAY1_END },
            existingCoverage: coverageFromTicks([DAY1_START.getTime() + 60 * 60 * 1000], TZ),
            timezone: TZ,
            now: FUTURE,
        });
        expect(results[0].missingStart).toBe(true);
        expect(results[0].missingEnd).toBe(true);
        expect(results[0].hasInteriorGap).toBe(false);
    });

    it('flags hasInteriorGap when mid-day gap exists', () => {
        const results = auditDays({
            requestedRange: { start: DAY1_START, end: DAY1_END },
            existingCoverage: coverageFromTicks([
                DAY1_START.getTime() + 5 * 60 * 1000,
                DAY1_START.getTime() + 10 * 60 * 1000,
                DAY1_START.getTime() + 70 * 60 * 1000, // 60 min gap (>30m threshold)
            ], TZ),
            timezone: TZ,
            now: FUTURE,
        });
        expect(results[0].hasInteriorGap).toBe(true);
    });

    it('clamps planned windows to now (avoids future days)', () => {
        const results = auditDays({
            requestedRange: { start: DAY1_START, end: new Date('2026-01-20T00:00:00.000Z') },
            existingCoverage: [],
            timezone: TZ,
            now: DAY1_END, // only Jan 10 is past or present, Jan 11 is in the future
        });
        // Since now is Jan 11 midnight (DAY1_END), requestedRange.end is clamped to Jan 11 06:00.
        // So it should only plan Jan 10 (1 day).
        expect(results).toHaveLength(1);
    });

    it('returns empty array for range with no days', () => {
        const results = auditDays({
            requestedRange: { start: DAY1_START, end: DAY1_START },
            existingCoverage: [],
            timezone: TZ,
            now: FUTURE,
        });
        expect(results).toHaveLength(0);
    });
});

describe('auditDays / planImport — DST transition days (America/Chicago)', () => {
    const TZ = 'America/Chicago';
    const FIVE_MIN = 5 * 60 * 1000;

    function timestampsEvery5Min(startMs: number, endMs: number): number[] {
        const out: number[] = [];
        for (let t = startMs; t < endMs; t += FIVE_MIN) out.push(t);
        return out;
    }

    it('spring-forward day is a single 23-hour window between true local midnights', () => {
        // Mar 8 2026: CST midnight = 06:00Z; Mar 9 CDT midnight = 05:00Z.
        const start = new Date('2026-03-08T06:00:00Z');
        const end = new Date('2026-03-09T05:00:00Z');
        const results = auditDays({
            requestedRange: { start, end },
            existingCoverage: [],
            timezone: TZ,
            now: new Date('2026-03-15T12:00:00Z'),
        });
        expect(results).toHaveLength(1);
        expect(results[0].windowStart).toEqual(start);
        expect(results[0].windowEnd).toEqual(end);
    });

    it('fall-back day is a single 25-hour window; full 5-min coverage plans no re-import', () => {
        // Nov 1 2026: CDT midnight = 05:00Z; Nov 2 CST midnight = 06:00Z (25 hours).
        const start = new Date('2026-11-01T05:00:00Z');
        const end = new Date('2026-11-02T06:00:00Z');
        const existing = timestampsEvery5Min(start.getTime(), end.getTime());
        expect(existing).toHaveLength(25 * 12);
        const windows = planImport({
            requestedRange: { start, end },
            existingCoverage: coverageFromTicks(existing, TZ),
            timezone: TZ,
            now: new Date('2026-11-15T12:00:00Z'),
        });
        expect(windows).toEqual([]);
    });
});

describe('generateDayWindows', () => {
    it('spring forward: one 23-hour window between true local midnights', () => {
        // Mar 8 2026: CST midnight = 06:00Z; Mar 9 CDT midnight = 05:00Z.
        const windows = generateDayWindows({
            requestedRange: { start: new Date('2026-03-08T06:00:00Z'), end: new Date('2026-03-09T05:00:00Z') },
            timezone: TZ,
            now: new Date('2026-03-20T00:00:00Z'),
        });
        expect(windows).toHaveLength(1);
        const [w] = windows;
        expect(w.windowStart.toISOString()).toBe('2026-03-08T06:00:00.000Z');
        expect(w.windowEnd.toISOString()).toBe('2026-03-09T05:00:00.000Z');
        expect(w.windowEnd.getTime() - w.windowStart.getTime()).toBe(23 * 60 * 60 * 1000);
    });

    it('fall back: one 25-hour window whose effective end equals window end once past', () => {
        // Nov 1 2026: CDT midnight = 05:00Z; Nov 2 CST midnight = 06:00Z.
        const windows = generateDayWindows({
            requestedRange: { start: new Date('2026-11-01T05:00:00Z'), end: new Date('2026-11-02T06:00:00Z') },
            timezone: TZ,
            now: new Date('2026-11-20T00:00:00Z'),
        });
        expect(windows).toHaveLength(1);
        const [w] = windows;
        expect(w.windowStart.toISOString()).toBe('2026-11-01T05:00:00.000Z');
        expect(w.windowEnd.toISOString()).toBe('2026-11-02T06:00:00.000Z');
        expect(w.windowEnd.getTime() - w.windowStart.getTime()).toBe(25 * 60 * 60 * 1000);
        expect(w.effectiveWindowEnd.toISOString()).toBe('2026-11-02T06:00:00.000Z');
        expect(w.isToday).toBe(false);
    });

    it('floors the first window start at the installation day', () => {
        const windows = generateDayWindows({
            requestedRange: { start: new Date('2026-01-01T06:00:00Z'), end: DAY1_END },
            timezone: TZ,
            installationDate: new Date('2026-01-10T15:00:00Z'), // mid-day install
            now: FUTURE,
        });
        expect(windows[0].windowStart.toISOString()).toBe(DAY1_START.toISOString());
    });

    it('emits one window per day, ascending, for a multi-day range', () => {
        const DAY2_END = new Date('2026-01-12T06:00:00.000Z');
        const windows = generateDayWindows({
            requestedRange: { start: DAY1_START, end: DAY2_END },
            timezone: TZ,
            now: FUTURE,
        });
        expect(windows.map(w => w.windowStart.toISOString())).toEqual([
            '2026-01-10T06:00:00.000Z',
            '2026-01-11T06:00:00.000Z',
        ]);
        expect(windows.map(w => w.windowEnd.toISOString())).toEqual([
            '2026-01-11T06:00:00.000Z',
            '2026-01-12T06:00:00.000Z',
        ]);
        expect(windows.every(w => w.windowStart.getTime() < w.windowEnd.getTime())).toBe(true);
    });

    it('clamps the final effective end to now and emits no window beyond now', () => {
        const now = new Date('2026-01-11T14:00:00.000Z'); // mid-day Jan 11 Chicago
        const windows = generateDayWindows({
            requestedRange: { start: DAY1_START, end: new Date('2026-01-20T00:00:00.000Z') },
            timezone: TZ,
            now,
        });
        expect(windows).toHaveLength(2);
        const last = windows[windows.length - 1];
        expect(last.windowStart.toISOString()).toBe('2026-01-11T06:00:00.000Z');
        expect(last.isToday).toBe(true);
        expect(last.effectiveWindowEnd.getTime()).toBe(now.getTime());
        expect(last.windowEnd.toISOString()).toBe('2026-01-12T06:00:00.000Z');
        expect(windows.every(w => w.windowStart.getTime() <= now.getTime())).toBe(true);
    });
});

describe('planImport from day record status', () => {
    // 287 of 288 samples: a 10-minute hole, under the 30-minute gap threshold.
    const nearlyFull = (extra: Partial<DailyCoverageStat>): DailyCoverageStat => ({
        localDayKey: DAY1_KEY, count: 287, first: DAY1_START, last: new Date(+DAY1_END - 300000), maxInteriorGapMs: 600000, ...extra,
    });
    const plan = (stat: DailyCoverageStat, refetchOpenDays: boolean, now = FUTURE) => planImport({
        requestedRange: { start: DAY1_START, end: DAY1_END }, existingCoverage: [stat], timezone: TZ, now, refetchOpenDays,
    });

    it('refetches an open day however small its gaps', () => {
        // Marked as a retry, so a window cap serves days with real gaps first.
        expect(plan(nearlyFull({ open: true }), true)).toEqual([{ start: DAY1_START, end: DAY1_END, openRetry: true }]);
        expect(plan(nearlyFull({ open: true, count: 100, maxInteriorGapMs: 12 * 3600000 }), true)).toEqual([{ start: DAY1_START, end: DAY1_END }]);
    });

    it('carries a record\'s fetch time onto its retry window', () => {
        const fetchedAt = new Date('2026-01-11T07:00:00.000Z');
        expect(plan(nearlyFull({ open: true, fetchedAt }), true)).toEqual([{ start: DAY1_START, end: DAY1_END, openRetry: true, fetchedAt }]);
    });

    it('never refetches complete or gapped days automatically', () => {
        expect(plan(nearlyFull({ archived: true }), true)).toEqual([]);
        expect(plan(nearlyFull({ archived: true, count: 100, maxInteriorGapMs: 12 * 3600000 }), true)).toEqual([]);
    });

    it('settles an open record once it ages past the gap-heal window, as its status would on a rewrite', () => {
        const days = (n: number) => new Date(+DAY1_END + n * 24 * 3600000);
        expect(plan(nearlyFull({ open: true }), true, days(14))).toHaveLength(1);
        expect(plan(nearlyFull({ open: true }), true, new Date(+days(14) + 1))).toEqual([]);
        expect(auditDays({ requestedRange: { start: DAY1_START, end: DAY1_END }, existingCoverage: [nearlyFull({ open: true, count: 10, maxInteriorGapMs: 12 * 3600000 })],
            timezone: TZ, now: days(15) })[0]).toMatchObject({ archived: true, open: false });
    });

    it('ages an open record from when Tesla access came back, so an outage stays refetchable', () => {
        const days = (n: number) => new Date(+DAY1_END + n * 24 * 3600000);
        const withRestore = (reachableSince: Date, now: Date) => planImport({
            requestedRange: { start: DAY1_START, end: DAY1_END }, existingCoverage: [nearlyFull({ open: true })], timezone: TZ,
            now, refetchOpenDays: true, reachableSince,
        });
        expect(withRestore(days(20), days(30))).toHaveLength(1);
        expect(withRestore(days(20), new Date(+days(34) + 1))).toEqual([]);
        // A restore before the day ended changes nothing.
        expect(withRestore(days(-1), new Date(+days(14) + 1))).toEqual([]);
    });

    it('leaves today\'s open record to the today refresh', () => {
        const midday = new Date(+DAY1_START + 12 * 3600000);
        expect(plan(nearlyFull({ open: true, last: new Date(+midday - 300000), count: 143 }), true, midday)).toEqual([]);
    });

    it('keeps the gap thresholds with day writes off', () => {
        expect(plan(nearlyFull({ open: true }), false)).toEqual([]);
    });
});
