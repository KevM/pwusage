import { describe, expect, it } from 'vitest';
import { retainedHistoryRange } from './history-retention';
const now = new Date('2026-10-01T18:00:00Z');
const policy = { history_retention_days: 90, history_retention_grace_until: null, history_retention_transition_pending: false };
describe('retained history availability', () => {
    it('keeps an available range and returns a serializable boundary', () => {
        const start = new Date('2026-08-01Z');
        const result = retainedHistoryRange(policy, 'UTC', start, now, now);
        expect(result.start).toEqual(start);
        expect(result.historyAvailability).toEqual({ status: 'available', availableFrom: '2026-07-03T00:00:00.000Z', effectiveDays: 90 });
    });
    it('marks a crossing bill partial and clamps its query', () => {
        const result = retainedHistoryRange(policy, 'America/Chicago', new Date('2026-07-01Z'), new Date('2026-08-01Z'), now);
        expect(result.historyAvailability.status).toBe('partial');
        expect(result.start.toISOString()).toBe('2026-07-03T05:00:00.000Z');
    });
    it('treats a range ending exactly at cutoff as unavailable', () => {
        expect(retainedHistoryRange(policy, 'UTC', new Date('2026-06-01Z'), new Date('2026-07-03Z'), now).historyAvailability.status).toBe('unavailable');
    });
    it('re-evaluates grace and extended history with the same range', () => {
        const start = new Date('2026-06-01Z');
        const end = new Date('2026-07-01Z');
        expect(retainedHistoryRange({ ...policy, history_retention_days: 365 }, 'UTC', start, end, now).historyAvailability.status).toBe('available');
        expect(retainedHistoryRange({ ...policy, history_retention_grace_until: new Date(now.getTime() + 1) }, 'UTC', start, end, now).historyAvailability.status).toBe('available');
        expect(retainedHistoryRange({ ...policy, history_retention_grace_until: now }, 'UTC', start, end, now).historyAvailability.status).toBe('unavailable');
    });
    it('rejects inverted and invalid date ranges', () => {
        expect(() => retainedHistoryRange(policy, 'UTC', now, now, now)).toThrow();
        expect(() => retainedHistoryRange(policy, 'UTC', new Date('bad'), now, now)).toThrow();
    });
});
