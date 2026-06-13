import { describe, it, expect } from 'vitest';
import { localDateKey, localDayBoundsUtc } from './local-day';

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
});
