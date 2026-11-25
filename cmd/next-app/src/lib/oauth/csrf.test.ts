import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOAuthCsrfToken, verifyOAuthCsrfToken } from './csrf';

describe('oauth csrf', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('creates and verifies a token bound to userId', async () => {
        vi.stubEnv('NODE_ENV', 'test');
        vi.stubEnv('AUTH_SECRET', 'test-auth-secret');

        const token = createOAuthCsrfToken('user-1');
        expect(await verifyOAuthCsrfToken(token, 'user-1')).toBe(true);
        expect(await verifyOAuthCsrfToken(token, 'user-2')).toBe(false);
    });

    it('throws in production when AUTH_SECRET is missing', () => {
        vi.stubEnv('NODE_ENV', 'production');
        vi.stubEnv('AUTH_SECRET', '');

        expect(() => createOAuthCsrfToken('user-1')).toThrow('AUTH_SECRET');
    });
});
