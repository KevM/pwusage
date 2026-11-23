import { afterEach, describe, expect, it, vi } from 'vitest';
import { isIsolatedTestAccount } from './site-membership-flag';

describe('isIsolatedTestAccount', () => {
    afterEach(() => vi.unstubAllEnvs());

    it('matches a listed user ID outside production', () => {
        vi.stubEnv('VERCEL_ENV', 'preview');
        vi.stubEnv('ISOLATED_TEST_USER_IDS', ' a , tester,,b ');
        expect(isIsolatedTestAccount('tester')).toBe(true);
        expect(isIsolatedTestAccount('owner')).toBe(false);
    });

    it('is off when the setting is unset or empty', () => {
        vi.stubEnv('VERCEL_ENV', 'preview');
        expect(isIsolatedTestAccount('tester')).toBe(false);
        vi.stubEnv('ISOLATED_TEST_USER_IDS', ' , ');
        expect(isIsolatedTestAccount('')).toBe(false);
    });

    it('is never on in production', () => {
        vi.stubEnv('VERCEL_ENV', 'production');
        vi.stubEnv('ISOLATED_TEST_USER_IDS', 'tester');
        expect(isIsolatedTestAccount('tester')).toBe(false);
    });
});
