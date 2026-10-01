import { describe, it, expect } from 'vitest';
import { planImport, splitAtSiteMidnight, auditDays, generateDayWindows } from './import-planner';

// America/Chicago is UTC-6 in winter, so site midnight = 06:00 UTC
const TZ = 'America/Chicago';
const DAY1_START = new Date('2026-01-10T06:00:00.000Z'); // midnight Chicago
const DAY1_END = new Date('2026-01-11T06:00:00.000Z');   // midnight next day
const FUTURE = new Date('2026-01-12T12:00:00.000Z');

function fiveMinTicks(from: Date, to: Date): number[] {
    const ticks: number[] = [];
    let t = from.getTime();
    while (t < to.getTime()) {
        ticks.push(t);
        t += 5 * 60 * 1000;
    }
    return ticks;
}

describe('planImport', () => {
    it('returns a window for a day with no existing data', () => {
        const result = planImport({
            requestedRange: { start: DAY1_START, end: DAY1_END },
            existingTimestamps: [],
            timezone: TZ,
            now: FUTURE,
        });
        expect(result).toHaveLength(1);
    });

    it('returns no windows when day is fully covered', () => {
        const result = planImport({
            requestedRange: { start: DAY1_START, end: DAY1_END },
            existingTimestamps: fiveMinTicks(DAY1_START, DAY1_END),
            timezone: TZ,
            now: FUTURE,
        });
        expect(result).toHaveLength(0);
    });

    it('returns a window when gap at start exceeds threshold', () => {
        // Only one point, 1 hour into the day — gap at start
        const result = planImport({
            requestedRange: { start: DAY1_START, end: DAY1_END },
            existingTimestamps: [DAY1_START.getTime() + 60 * 60 * 1000],
            timezone: TZ,
            now: FUTURE,
        });
        expect(result).toHaveLength(1);
    });

    it('returns a window when gap at end exceeds threshold', () => {
        // Only one point, 1 hour before end of day — gap at end
        const result = planImport({
            requestedRange: { start: DAY1_START, end: DAY1_END },
            existingTimestamps: [DAY1_END.getTime() - 60 * 60 * 1000],
            timezone: TZ,
            now: FUTURE,
        });
        expect(result).toHaveLength(1);
    });

    it('returns a window when there is an interior gap', () => {
        // Points at start and end of day, but a huge gap in the middle
        const existingTimestamps = [
            DAY1_START.getTime() + 5 * 60 * 1000,
            DAY1_END.getTime() - 5 * 60 * 1000,
        ];
        const result = planImport({
            requestedRange: { start: DAY1_START, end: DAY1_END },
            existingTimestamps,
            timezone: TZ,
            now: FUTURE,
        });
        expect(result).toHaveLength(1);
    });

    it('returns window even when fully covered if forceRefetch is true', () => {
        const result = planImport({
            requestedRange: { start: DAY1_START, end: DAY1_END },
            existingTimestamps: fiveMinTicks(DAY1_START, DAY1_END),
            timezone: TZ,
            forceRefetch: true,
            now: FUTURE,
        });
        expect(result).toHaveLength(1);
    });

    it('clamps start to installationDate', () => {
        const result = planImport({
            requestedRange: { start: new Date('2026-01-01T06:00:00.000Z'), end: DAY1_END },
            existingTimestamps: [],
            timezone: TZ,
            installationDate: DAY1_START,
            now: FUTURE,
        });
        result.forEach(w => {
            expect(w.start.getTime()).toBeGreaterThanOrEqual(DAY1_START.getTime());
        });
    });

    it('returns two windows for two days each missing data', () => {
        const DAY2_END = new Date('2026-01-12T06:00:00.000Z');
        const result = planImport({
            requestedRange: { start: DAY1_START, end: DAY2_END },
            existingTimestamps: [],
            timezone: TZ,
            now: FUTURE,
        });
        expect(result).toHaveLength(2);
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
            existingTimestamps: [],
            timezone: TZ,
            now: FUTURE,
        });
        expect(results).toHaveLength(2);
    });

    it('reports count and first/last for a covered day', () => {
        const ticks = fiveMinTicks(DAY1_START, DAY1_END);
        const results = auditDays({
            requestedRange: { start: DAY1_START, end: DAY1_END },
            existingTimestamps: ticks,
            timezone: TZ,
            now: FUTURE,
        });
        expect(results[0].count).toBe(ticks.length);
        expect(results[0].firstInWindow).toBe(DAY1_START.getTime());
        expect(results[0].missingStart).toBe(false);
        expect(results[0].missingEnd).toBe(false);
        expect(results[0].hasInteriorGap).toBe(false);
    });

    it('flags missingStart when gap at beginning exceeds threshold', () => {
        const results = auditDays({
            requestedRange: { start: DAY1_START, end: DAY1_END },
            existingTimestamps: [DAY1_START.getTime() + 60 * 60 * 1000],
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
            existingTimestamps: [
                DAY1_START.getTime() + 5 * 60 * 1000,
                DAY1_START.getTime() + 10 * 60 * 1000,
                DAY1_START.getTime() + 70 * 60 * 1000, // 60 min gap (>30m threshold)
            ],
            timezone: TZ,
            now: FUTURE,
        });
        expect(results[0].hasInteriorGap).toBe(true);
    });

    it('clamps planned windows to now (avoids future days)', () => {
        const results = auditDays({
            requestedRange: { start: DAY1_START, end: new Date('2026-01-20T00:00:00.000Z') },
            existingTimestamps: [],
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
            existingTimestamps: [],
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
            existingTimestamps: [],
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
            existingTimestamps: existing,
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

