import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
    cookies: vi.fn(),
    redirect: vi.fn(),
    getAppBaseUrl: vi.fn(() => 'http://localhost:5173'),
    cookieSet: vi.fn(),
    cookieDelete: vi.fn(),
}));

vi.mock('next/headers', () => ({
    cookies: mocks.cookies
}));

vi.mock('next/navigation', () => ({
    redirect: mocks.redirect
}));

vi.mock('@/lib/url-utils', () => ({
    getAppBaseUrl: mocks.getAppBaseUrl
}));

import { buildTeslaAuthorizeUrl } from '@/lib/tesla-authorize-url';
import { GET } from './route';

// File scope, not inside either describe: the only other reset is the beforeEach
// in 'GET /login', so a stub leaked from there would reach a test in a sibling or
// top-level describe with nothing to restore it.
afterEach(() => {
    vi.unstubAllEnvs();
});

describe('GET /login', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        process.env.PUBLIC_TESLA_OAUTH_CLIENT_ID = 'tesla-client-id';
        mocks.cookies.mockResolvedValue({
            set: mocks.cookieSet,
            delete: mocks.cookieDelete,
        });
    });

    it('sets state and nonce cookies and redirects to Tesla OAuth URL', async () => {
        const req = new NextRequest('http://localhost:5173/login');
        await GET(req);

        expect(mocks.cookieSet).toHaveBeenCalledWith('auth_state', expect.any(String), expect.any(Object));
        expect(mocks.cookieSet).toHaveBeenCalledWith('auth_nonce', expect.any(String), expect.any(Object));
        expect(mocks.redirect).toHaveBeenCalledWith(expect.stringContaining('https://auth.tesla.com/oauth2/v3/authorize'));
    });

    it('redirects with prompt_missing_scopes and never forces prompt=login', async () => {
        const req = new NextRequest('http://localhost:5173/login');
        await GET(req);

        const redirectUrl = mocks.redirect.mock.calls[0][0] as string;
        expect(redirectUrl).toContain('prompt_missing_scopes=true');
        expect(redirectUrl).not.toContain('prompt=login');
    });

    // The route<->builder contract. The builder tests pin the builder and the
    // other route tests pin the cookies, but nothing connected them: every wiring
    // change at the call site was silent. Expected clientId is read back from the
    // env rather than hard-coded, so a hard-coded id at the call site fails here.
    it('redirects to the authorize URL built from the exact state and nonce it issued as cookies', async () => {
        const req = new NextRequest('http://localhost:5173/login');
        await GET(req);

        const cookieValue = (name: string): string => {
            const call = mocks.cookieSet.mock.calls.find((args) => args[0] === name);
            if (!call) throw new Error(`expected a ${name} cookie write`);
            return call[1] as string;
        };
        const clientId = process.env.PUBLIC_TESLA_OAUTH_CLIENT_ID;
        if (clientId === undefined) throw new Error('expected PUBLIC_TESLA_OAUTH_CLIENT_ID to be set');

        expect(mocks.redirect).toHaveBeenCalledWith(buildTeslaAuthorizeUrl({
            state: cookieValue('auth_state'),
            nonce: cookieValue('auth_nonce'),
            callbackUrl: 'http://localhost:5173/auth/tesla-callback',
            clientId,
        }));
    });

    it('stores auth_callback cookie for safe relative paths', async () => {
        const req = new NextRequest('http://localhost:5173/login?callback=/settings');
        await GET(req);

        expect(mocks.cookieSet).toHaveBeenCalledWith('auth_callback', '/settings', expect.any(Object));
    });

    it('rejects //evil, /\\evil, and absolute URLs for auth_callback cookie', async () => {
        const unsafeCallbacks = [
            '//evil.com',
            '/\\evil.com',
            'https://evil.com',
            'javascript:alert(1)'
        ];

        for (const unsafe of unsafeCallbacks) {
            vi.clearAllMocks();
            const req = new NextRequest(`http://localhost:5173/login?callback=${encodeURIComponent(unsafe)}`);
            await GET(req);

            expect(mocks.cookieSet).not.toHaveBeenCalledWith('auth_callback', expect.any(String), expect.any(Object));
        }
    });

    it('binds valid native login state and challenge to a short lived server attempt', async () => {
        const challenge = 'A'.repeat(43);
        const state = 'B'.repeat(32);
        const req = new NextRequest(`http://localhost:5173/login?mobile_challenge=${challenge}&mobile_state=${state}`);
        await GET(req);

        expect(mocks.cookieSet).toHaveBeenCalledWith('auth_mobile_attempt', expect.any(String), expect.objectContaining({
            httpOnly: true, path: '/', maxAge: 600,
        }));
        expect(mocks.cookieSet).toHaveBeenCalledWith('auth_mobile_challenge', challenge, expect.any(Object));
        expect(mocks.cookieSet).toHaveBeenCalledWith('auth_mobile_state', state, expect.any(Object));
    });

    it('rejects malformed mobile callbacks instead of starting a web login', async () => {
        const req = new NextRequest('http://localhost:5173/login?mobile_challenge=bad&mobile_state=also-bad');
        const response = await GET(req);
        expect(response.status).toBe(400);
        expect(mocks.redirect).not.toHaveBeenCalled();
    });

    it('intercepts instead of throwing when PUBLIC_TESLA_OAUTH_CLIENT_ID is unset', async () => {
        vi.stubEnv('PUBLIC_TESLA_OAUTH_CLIENT_ID', '');
        const req = new NextRequest('http://localhost:5173/login');

        const response = await GET(req);

        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({ error: 'Server misconfigured' });
        expect(mocks.redirect).not.toHaveBeenCalled();
    });

    // The whole point of intercepting: a mobile sign-in must still be handed the
    // pwusage://auth/callback redirect, or the app reports `invalidCallback` and
    // shows a raw 500 page rather than `AuthError.serverRejectedLogin`.
    it('redirects a mobile attempt to the app callback when the client id is unset', async () => {
        vi.stubEnv('PUBLIC_TESLA_OAUTH_CLIENT_ID', '');
        const challenge = 'A'.repeat(43);
        const state = 'B'.repeat(32);
        const req = new NextRequest(`http://localhost:5173/login?mobile_challenge=${challenge}&mobile_state=${state}`);

        const response = await GET(req);

        const location = new URL(response.headers.get('location') as string);
        expect(location.protocol).toBe('pwusage:');
        expect(location.searchParams.get('error')).toBe('login_unavailable');
        expect(location.searchParams.get('state')).toBe(state);
        expect(mocks.redirect).not.toHaveBeenCalled();
    });

    // Guard is positioned before the cookie writes, so a misconfigured deploy
    // must not leave a half-started attempt behind.
    it('writes no cookies and clears stale attempt cookies when the client id is unset', async () => {
        vi.stubEnv('PUBLIC_TESLA_OAUTH_CLIENT_ID', '');
        const challenge = 'A'.repeat(43);
        const state = 'B'.repeat(32);
        const req = new NextRequest(`http://localhost:5173/login?mobile_challenge=${challenge}&mobile_state=${state}`);

        await GET(req);

        expect(mocks.cookieSet).not.toHaveBeenCalled();
        // Nothing downstream clears these, since we never redirect to Tesla.
        for (const name of ['auth_state', 'auth_nonce', 'auth_callback', 'auth_mobile_attempt', 'auth_mobile_challenge', 'auth_mobile_state']) {
            expect(mocks.cookieDelete).toHaveBeenCalledWith(name);
        }
    });

    // A whitespace-only value must fail here, not reach Tesla as a blank client_id.
    it('treats a whitespace-only client id as missing', async () => {
        vi.stubEnv('PUBLIC_TESLA_OAUTH_CLIENT_ID', '   ');
        const req = new NextRequest('http://localhost:5173/login');

        const response = await GET(req);

        expect(response.status).toBe(500);
        expect(mocks.redirect).not.toHaveBeenCalled();
    });
});
