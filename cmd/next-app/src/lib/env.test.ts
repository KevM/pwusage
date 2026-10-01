import { describe, expect, it } from 'vitest';
import { requireEnv } from './env';

describe('requireEnv', () => {
    it('returns the value when present', () => {
        process.env.PWUSAGE_TEST_ENV = 'present';
        expect(requireEnv('PWUSAGE_TEST_ENV')).toBe('present');
        delete process.env.PWUSAGE_TEST_ENV;
    });

    it('throws by name instead of silently defaulting', () => {
        expect(() => requireEnv('PWUSAGE_DEFINITELY_UNSET_VAR')).toThrow(
            /PWUSAGE_DEFINITELY_UNSET_VAR/
        );
    });

    it('treats a whitespace-only value as missing', () => {
        process.env.PWUSAGE_BLANK_ENV = '   ';
        expect(() => requireEnv('PWUSAGE_BLANK_ENV')).toThrow(/PWUSAGE_BLANK_ENV/);
        delete process.env.PWUSAGE_BLANK_ENV;
    });

    // Guards the "do not memoize" decision recorded in env.ts. If a cache is ever
    // added, this fails: the second read observes the delete rather than the
    // value read a moment earlier.
    it('observes a variable removed since the previous read', () => {
        process.env.PWUSAGE_REMOVED_ENV = 'present';
        expect(requireEnv('PWUSAGE_REMOVED_ENV')).toBe('present');
        delete process.env.PWUSAGE_REMOVED_ENV;
        expect(() => requireEnv('PWUSAGE_REMOVED_ENV')).toThrow(/PWUSAGE_REMOVED_ENV/);
    });
});
