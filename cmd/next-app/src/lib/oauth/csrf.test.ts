import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOAuthCsrfToken, isSameOriginPost, verifyOAuthCsrfToken } from './csrf';

describe('oauth csrf', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('creates and verifies a token bound to userId', async () => {
        vi.stubEnv('NODE_ENV', 'test');
        vi.stubEnv('AUTH_SECRET', 'test-auth-secret');

        const request = { clientId: 'c', redirectUri: 'https://a.example/cb', codeChallenge: 'x', resource: 'r', scope: 's' };
        const token = createOAuthCsrfToken('user-1', request);
        expect(await verifyOAuthCsrfToken(token, 'user-1', request)).toBe(true);
        expect(await verifyOAuthCsrfToken(token, 'user-2', request)).toBe(false);
    });

    it('binds the token to the authorization request rendered on the consent screen', async () => {
        vi.stubEnv('NODE_ENV', 'test');
        vi.stubEnv('AUTH_SECRET', 'test-auth-secret');
        const request = { clientId: 'pwu_client_1', redirectUri: 'https://claude.ai/cb', codeChallenge: 'c'.repeat(43), resource: 'https://pwusage.fm.rodeo/api/mcp', scope: 'billing:read usage:read' };
        const token = createOAuthCsrfToken('user-1', request);
        expect(await verifyOAuthCsrfToken(token, 'user-1', request)).toBe(true);
        expect(await verifyOAuthCsrfToken(token, 'user-1', { ...request, redirectUri: 'https://evil.example/cb' })).toBe(false);
        expect(await verifyOAuthCsrfToken(token, 'user-1', { ...request, clientId: 'pwu_client_2' })).toBe(false);
        expect(await verifyOAuthCsrfToken(token, 'user-1', { ...request, scope: 'billing:read' })).toBe(false);
    });

    it('accepts a same-origin POST on whatever host served it (dev ports, previews)', () => {
        vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:5173');
        const post = (origin: string) => new Request('http://localhost:5174/oauth/authorize/decision', { method: 'POST', headers: { Origin: origin } });
        expect(isSameOriginPost(post('http://localhost:5174'))).toBe(true);
        expect(isSameOriginPost(post('https://evil.example'))).toBe(false);
    });

    it('throws in production when AUTH_SECRET is missing', () => {
        vi.stubEnv('NODE_ENV', 'production');
        vi.stubEnv('AUTH_SECRET', '');

        expect(() => createOAuthCsrfToken('user-1', { clientId: 'c', redirectUri: 'r', codeChallenge: 'x', resource: 'r', scope: 's' })).toThrow('AUTH_SECRET');
    });
});
