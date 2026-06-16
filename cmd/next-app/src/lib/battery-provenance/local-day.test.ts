import { describe, it, expect } from 'vitest';
import { localDateKey, localDayBoundsUtc, addLocalDays, localHour } from './local-day';

describe('local-day', () => {
    it('maps an instant to its local calendar date', () => {
        // 2026-01-02T03:00:00Z is still 2026-01-01 in America/Los_Angeles (UTC-8).
        expect(localDateKey(new Date('2026-01-02T03:00:00Z'), 'America/Los_Angeles')).toBe('2026-01-01');
    });

    it('computes UTC bounds for a local day', () => {
        const { start, end } = localDayBoundsUtc('2026-01-01', 'America/Los_Angeles');
        // PST is UTC-8: local midnight = 08:00Z.
        expect(start.toISOString()).toBe('2026-01-01T08:00:00.000Z');
        expect(end.toISOString()).toBe('2026-01-02T08:00:00.000Z');
    });

    describe('addLocalDays', () => {
        it('advances a YYYY-MM-DD string across month/year ends', () => {
            expect(addLocalDays('2026-01-31', 1)).toBe('2026-02-01');
            expect(addLocalDays('2026-12-31', 1)).toBe('2027-01-01');
            expect(addLocalDays('2026-03-01', -1)).toBe('2026-02-28');
        });
    });
});

describe('localHour', () => {
    it('returns the local clock hour in the site timezone', () => {
        // 2026-01-07T11:30:00Z is 03:30 in America/Los_Angeles (UTC-8)
        expect(localHour(new Date('2026-01-07T11:30:00Z'), 'America/Los_Angeles')).toBe(3);
        // …and 11:30 in UTC
        expect(localHour(new Date('2026-01-07T11:30:00Z'), 'UTC')).toBe(11);
    });

    it('maps local midnight to hour 0', () => {
        // 2026-01-07T08:00:00Z is 00:00 in America/Los_Angeles
        expect(localHour(new Date('2026-01-07T08:00:00Z'), 'America/Los_Angeles')).toBe(0);
    });
});

