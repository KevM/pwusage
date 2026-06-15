import { afterEach, describe, expect, it } from 'vitest';
import { retentionDays, retentionCutoff } from './retention';

const ORIGINAL = process.env.DATA_RETENTION_DAYS;
afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.DATA_RETENTION_DAYS;
    else process.env.DATA_RETENTION_DAYS = ORIGINAL;
});

describe('retentionDays', () => {
    it('parses a positive integer as a finite retention window', () => {
        expect(retentionDays('365')).toBe(365);
        expect(retentionDays('90')).toBe(90);
    });

    it('treats unset/empty/0/negative/non-numeric as keep-forever (null)', () => {
        expect(retentionDays(undefined)).toBeNull();
        expect(retentionDays('')).toBeNull();
        expect(retentionDays('0')).toBeNull();
        expect(retentionDays('-5')).toBeNull();
        expect(retentionDays('abc')).toBeNull();
    });
});

describe('retentionCutoff', () => {
    it('returns the epoch when retention is disabled (keep forever)', () => {
        delete process.env.DATA_RETENTION_DAYS;
        expect(retentionCutoff(Date.now()).getTime()).toBe(0);
    });

    it('returns now minus the retention window when set', () => {
        process.env.DATA_RETENTION_DAYS = '10';
        const now = 1_700_000_000_000;
        expect(retentionCutoff(now).getTime()).toBe(now - 10 * 86_400_000);
    });
});
