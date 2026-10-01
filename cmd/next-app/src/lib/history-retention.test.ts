import { describe, expect, it } from 'vitest';
import { resolveHistoryRetention, changeHistoryRetention, bootstrapHistoryRetention, newAccountTransitionPending } from './history-retention';

const now = new Date('2026-10-01T18:00:00Z');
const standard = { history_retention_days: 90, history_retention_grace_until: null, history_retention_transition_pending: false };

describe('history retention policy', () => {
    it('uses 90 local calendar days, floored to midnight', () => {
        expect(resolveHistoryRetention(standard, 'UTC', now).cutoff.toISOString()).toBe('2026-07-03T00:00:00.000Z');
        expect(resolveHistoryRetention(standard, 'America/Chicago', now).cutoff.toISOString()).toBe('2026-07-03T05:00:00.000Z');
    });
    it('keeps 365 days for extended accounts and existing accounts awaiting notice', () => {
        for (const policy of [{ ...standard, history_retention_days: 365 }, { ...standard, history_retention_transition_pending: true }]) {
            expect(resolveHistoryRetention(policy, 'UTC', now).cutoff.toISOString()).toBe('2025-10-01T00:00:00.000Z');
        }
    });
    it('ends grace exactly at expiry, evaluated with the supplied clock', () => {
        const policy = { ...standard, history_retention_grace_until: now };
        expect(resolveHistoryRetention(policy, 'UTC', new Date(now.getTime() - 1)).effectiveDays).toBe(365);
        expect(resolveHistoryRetention(policy, 'UTC', now).effectiveDays).toBe(90);
        expect(resolveHistoryRetention(policy, 'UTC', new Date(now.getTime() + 1)).effectiveDays).toBe(90);
    });
    it('subtracts calendar days across DST without moving local midnight', () => {
        expect(resolveHistoryRetention(standard, 'America/Chicago', new Date('2026-06-06T12:00:00Z')).cutoff.toISOString()).toBe('2026-03-08T06:00:00.000Z');
        expect(resolveHistoryRetention(standard, 'America/Chicago', new Date('2027-01-30T12:00:00Z')).cutoff.toISOString()).toBe('2026-11-01T05:00:00.000Z');
    });
    it('rejects invalid days, grace dates, missing transition state, and clocks', () => {
        for (const days of [0, 180, 90.5, undefined]) {
            expect(() => resolveHistoryRetention({ ...standard, history_retention_days: days }, 'UTC', now)).toThrow();
        }
        expect(() => resolveHistoryRetention({ ...standard, history_retention_grace_until: 'bad' }, 'UTC', now)).toThrow();
        expect(() => resolveHistoryRetention({ ...standard, history_retention_transition_pending: undefined }, 'UTC', now)).toThrow();
        expect(() => resolveHistoryRetention(standard, 'UTC', new Date('bad'))).toThrow();
    });
});

describe('retention transitions', () => {
    it('starts a 30-day grace on a real downgrade', () => {
        expect(changeHistoryRetention({ ...standard, history_retention_days: 365 }, 90, now)).toEqual({ ...standard, history_retention_grace_until: new Date('2026-10-31T18:00:00Z') });
    });
    it('does not extend grace on repeated 90-day saves', () => {
        const policy = { ...standard, history_retention_grace_until: new Date('2026-10-15T00:00:00Z') };
        expect(changeHistoryRetention(policy, 90, now)).toEqual(policy);
    });
    it('clears grace and pending transition when extended history is granted', () => {
        expect(changeHistoryRetention({ ...standard, history_retention_transition_pending: true, history_retention_grace_until: now }, 365, now)).toEqual({ ...standard, history_retention_days: 365 });
    });
    it('does not bypass pending notice through a 90-day save', () => {
        const policy = { ...standard, history_retention_transition_pending: true };
        expect(changeHistoryRetention(policy, 90, now)).toEqual(policy);
    });
    it('rejects unsupported assignment', () => {
        expect(() => changeHistoryRetention(standard, 180, now)).toThrow();
    });
    it('bootstraps pending accounts from notice plus 30 days and is idempotent', () => {
        const initialized = bootstrapHistoryRetention({ ...standard, history_retention_transition_pending: true }, now);
        expect(initialized).toEqual({ ...standard, history_retention_grace_until: new Date('2026-10-31T18:00:00Z') });
        expect(bootstrapHistoryRetention(initialized, new Date('2026-10-10T18:00:00Z'))).toEqual(initialized);
    });
    it('preserves later legitimate grace, extended exceptions, and new accounts', () => {
        const later = { ...standard, history_retention_transition_pending: true, history_retention_grace_until: new Date('2026-12-01T00:00:00Z') };
        expect(bootstrapHistoryRetention(later, now).history_retention_grace_until).toEqual(later.history_retention_grace_until);
        const extended = { ...standard, history_retention_days: 365 };
        expect(bootstrapHistoryRetention(extended, now)).toEqual(extended);
        expect(bootstrapHistoryRetention(standard, now)).toEqual(standard);
    });
});

describe('new-account policy cutover', () => {
    it('keeps pre-announcement accounts pending, including when no cutover is configured', () => {
        expect(newAccountTransitionPending(undefined, now)).toBe(true);
        expect(newAccountTransitionPending('2026-10-02T00:00:00Z', now)).toBe(true);
    });
    it('starts new accounts at 90 days exactly at the disclosed policy start', () => {
        expect(newAccountTransitionPending(now.toISOString(), now)).toBe(false);
        expect(newAccountTransitionPending('2026-09-01T00:00:00Z', now)).toBe(false);
    });
    it('rejects ambiguous or malformed cutovers instead of silently reducing history', () => {
        for (const value of ['bad', '2026-10-01', '2026-10-01T00:00:00']) expect(() => newAccountTransitionPending(value, now)).toThrow();
    });
});
