import { describe, it, expect } from 'vitest';
import { getSiteMidnight } from './date-utils';

describe('getSiteMidnight', () => {
    const tz = 'America/Los_Angeles';

    it('returns local midnight on a standard non-transition day', () => {
        // July 1, 2026 12:00:00 PDT = 19:00:00 UTC
        const d = new Date('2026-07-01T19:00:00Z');
        const midnight = getSiteMidnight(d, tz);
        // Midnight PDT on July 1, 2026 is 07:00:00 UTC (offset is -7h)
        expect(midnight.toISOString()).toBe('2026-07-01T07:00:00.000Z');
    });

    it('returns correct local midnight on spring-forward transition day', () => {
        // March 8, 2026 is DST Spring Forward in LA.
        // Local midnight is March 8, 00:00:00 PST (offset is -8h) -> 08:00:00 UTC.
        // Query time is March 8, 12:00:00 PDT (offset is -7h) -> 19:00:00 UTC.
        const d = new Date('2026-03-08T19:00:00Z');
        const midnight = getSiteMidnight(d, tz);
        expect(midnight.toISOString()).toBe('2026-03-08T08:00:00.000Z');
    });

    it('returns correct local midnight on fall-back transition day', () => {
        // November 1, 2026 is DST Fall Back in LA.
        // Local midnight is Nov 1, 00:00:00 PDT (offset is -7h) -> 07:00:00 UTC.
        // Query time is Nov 1, 12:00:00 PST (offset is -8h) -> 20:00:00 UTC.
        const d = new Date('2026-11-01T20:00:00Z');
        const midnight = getSiteMidnight(d, tz);
        expect(midnight.toISOString()).toBe('2026-11-01T07:00:00.000Z');
    });
});
