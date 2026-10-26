import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
    cookies: vi.fn(),
    redirect: vi.fn((path: string) => { throw Object.assign(new Error('Redirect'), { digest: `NEXT_REDIRECT;replace;${path};307;` }); }),
    handleTeslaCallback: vi.fn(),
    signSiteToken: vi.fn(() => 'signed-site-token'),
    cookieDelete: vi.fn(),
    cookieSet: vi.fn(),
    getCookie: vi.fn(),
    getAuthState: vi.fn(async () => ({ isActive: true, sessionVersion: 0, roles: ['user'] })),
    createMobileLoginHandoff: vi.fn(async () => ({ code: 'opaque-handoff-code', attemptId: '9b47b05a-3f0b-498e-b604-9e43fa7df015' })),
}));

vi.mock('next/headers', () => ({
    cookies: mocks.cookies
}));

vi.mock('next/navigation', () => ({
    redirect: mocks.redirect
}));

vi.mock('@/lib/tesla-auth-service', () => ({
    TeslaAuthService: class {
        handleTeslaCallback = mocks.handleTeslaCallback;
    }
}));

vi.mock('@/lib/auth-jwt', () => ({
    signSiteToken: mocks.signSiteToken,
    COOKIE_MAX_AGE_SECONDS: 86400
}));
vi.mock('@/lib/mobile-login-handoff', () => ({
    createMobileLoginHandoff: mocks.createMobileLoginHandoff,
    isValidMobileLoginParameters: (challenge: string, state: string) => challenge.length === 43 && state.length >= 22,
}));

vi.mock('@/lib/user-repo', () => ({
    UserRepo: class {
        getAuthState = mocks.getAuthState;
    }
}));

import { GET } from './route';

describe('GET /auth/tesla-callback', () => {
    const origEnv = process.env;

    beforeEach(() => {
        vi.clearAllMocks();
        process.env = {
            ...origEnv,
            PUBLIC_TESLA_OAUTH_CLIENT_ID: 'client-123',
            TESLA_OAUTH_SECRET: 'secret-123'
        };

        mocks.cookies.mockResolvedValue({
            get: mocks.getCookie,
            set: mocks.cookieSet,
            delete: mocks.cookieDelete
        });
    });

    afterEach(() => {
        process.env = origEnv;
        // vi.clearAllMocks() clears calls but not implementations, and the mobile
        // tests below install a getCookie implementation. Reset it here so a test
        // that fails partway through cannot hand a mobile state cookie to the next
        // one - which would turn the web-path assertions into 307 redirects.
        mocks.getCookie.mockReset();
    });

    it('returns 500 when environment variables are missing', async () => {
        delete process.env.PUBLIC_TESLA_OAUTH_CLIENT_ID;

        const req = new NextRequest('http://localhost:5173/auth/tesla-callback?code=abc&state=xyz');
        const res = await GET(req);
        expect(res.status).toBe(500);
    });

    // handleTeslaCallback reads both via requireEnv and throws on a missing
    // one, so without this check a deploy missing TESLA_OAUTH_SECRET would
    // surface as an unhandled throw (raw 500 from Next) rather than this route's
    // own JSON. Asserted per-variable so adding a fourth cannot silently skip it.
    it.each([
        'PUBLIC_TESLA_OAUTH_CLIENT_ID',
        'TESLA_OAUTH_SECRET',
    ])('returns 500 without reaching the auth service when %s is missing', async (variable) => {
        delete process.env[variable];

        const req = new NextRequest('http://localhost:5173/auth/tesla-callback?code=abc&state=xyz');
        const res = await GET(req);

        expect(res.status).toBe(500);
        expect(await res.json()).toEqual({ error: 'Server misconfigured' });
        expect(mocks.handleTeslaCallback).not.toHaveBeenCalled();
    });

    // A whitespace-only value is not a value: requireEnv trims and then rejects it,
    // so the guard above has to agree. Truthiness alone would pass it, and the
    // request would then die downstream as `invalid-id-token` (or a raw throw) -
    // the exact misleading outcome this guard exists to prevent. Same two
    // variables as the missing-var case above, so a third cannot skip this.
    it.each([
        'PUBLIC_TESLA_OAUTH_CLIENT_ID',
        'TESLA_OAUTH_SECRET',
    ])('treats a whitespace-only %s as missing', async (variable) => {
        process.env[variable] = '   ';

        const req = new NextRequest('http://localhost:5173/auth/tesla-callback?code=abc&state=xyz');
        const res = await GET(req);

        expect(res.status).toBe(500);
        expect(await res.json()).toEqual({ error: 'Server misconfigured' });
        expect(mocks.handleTeslaCallback).not.toHaveBeenCalled();
    });

    it('does not require the retired audience environment variable', async () => {
        delete process.env.PUBLIC_TESLA_OAUTH_AUDIENCE;
        mocks.handleTeslaCallback.mockResolvedValue({ status: 'state-mismatch' });

        const req = new NextRequest('http://localhost:5173/auth/tesla-callback?code=abc&state=xyz');
        const res = await GET(req);

        expect(mocks.handleTeslaCallback).toHaveBeenCalled();
        expect(res.status).toBe(401);
    });

    it('returns mobile login to the app when the client id is whitespace-only', async () => {
        process.env.PUBLIC_TESLA_OAUTH_CLIENT_ID = '   ';
        mocks.getCookie.mockImplementation((name: string) => name === 'auth_mobile_state'
            ? { value: 'B'.repeat(32) }
            : undefined);

        const response = await GET(new NextRequest('https://pwusage.test/auth/tesla-callback?code=tesla-code&state=xyz'));
        const location = response.headers.get('location') || '';

        expect(location).toMatch(/^pwusage:\/\/auth\/callback\?/);
        expect(location).toContain('error=login_unavailable');
        expect(location).toContain('state=' + 'B'.repeat(32));
        expect(mocks.cookieDelete).toHaveBeenCalledWith('auth_mobile_state');
        expect(mocks.handleTeslaCallback).not.toHaveBeenCalled();
    });

    it('returns 400 when code or state parameters are missing', async () => {
        const req = new NextRequest('http://localhost:5173/auth/tesla-callback?code=abc');
        const res = await GET(req);
        expect(res.status).toBe(400);
    });

    it('maps auth service failure statuses to expected HTTP responses', async () => {
        const failureCases = [
            { status: 'state-mismatch', expectedHttp: 401 },
            { status: 'token-exchange-failed', statusCode: 502, expectedHttp: 502 },
            { status: 'invalid-id-token', expectedHttp: 401 },
            { status: 'nonce-mismatch', expectedHttp: 401 },
            { status: 'db-error', expectedHttp: 500 },
            { status: 'fleet-api-failed', reason: 'region', expectedHttp: 502 }
        ];

        for (const failure of failureCases) {
            vi.clearAllMocks();
            mocks.handleTeslaCallback.mockResolvedValue(failure);

            const req = new NextRequest('http://localhost:5173/auth/tesla-callback?code=abc&state=xyz');
            const res = await GET(req);
            expect(res.status).toBe(failure.expectedHttp);
        }
    });

    it.each([
        ['db-error', { status: 'db-error' }, 500, 'Could not finish Tesla sign-in'],
        ['fleet-api-failed', { status: 'fleet-api-failed', reason: 'region' }, 502, 'Failed to load Tesla products'],
    ])('returns %s as an explicit error instead of a success redirect', async (_label, result, expectedHttp, expectedError) => {
        mocks.handleTeslaCallback.mockResolvedValue(result);
        mocks.getCookie.mockReturnValue(undefined);

        const req = new NextRequest('http://localhost:5173/auth/tesla-callback?code=abc&state=xyz');
        const res = await GET(req);

        expect(res.status).toBe(expectedHttp);
        expect(await res.json()).toEqual({ error: expectedError });
        expect(mocks.cookieDelete).toHaveBeenCalledWith('auth_state');
        expect(mocks.cookieSet).not.toHaveBeenCalledWith('site_auth', expect.any(String), expect.any(Object));
        expect(mocks.redirect).not.toHaveBeenCalled();
    });

    it('deletes auth cookies and sets site_auth on success with sites/roles', async () => {
        mocks.handleTeslaCallback.mockResolvedValue({
            status: 'success',
            siteIds: ['site-1'],
            roles: ['user'],
            userId: 'user-123'
        });
        mocks.getCookie.mockReturnValue(undefined);

        const req = new NextRequest('http://localhost:5173/auth/tesla-callback?code=abc&state=xyz');
        await expect(GET(req)).rejects.toMatchObject({ digest: expect.stringContaining('NEXT_REDIRECT;') });

        expect(mocks.cookieSet).toHaveBeenCalledWith('site_auth', 'signed-site-token', expect.any(Object));
        expect(mocks.cookieDelete).toHaveBeenCalledWith('auth_state');
        expect(mocks.cookieDelete).toHaveBeenCalledWith('auth_nonce');
        expect(mocks.cookieDelete).toHaveBeenCalledWith('auth_callback');
        expect(mocks.redirect).toHaveBeenCalledWith('/');
        // Fresh logins stamp the DB session_version so a re-login after
        // sign-out-everywhere is not immediately treated as a revoked session.
        expect(mocks.getAuthState).toHaveBeenCalledWith('user-123');
        expect(mocks.signSiteToken).toHaveBeenCalledWith(['site-1'], ['user'], 'user-123', undefined, 0);
    });

    it('stamps the current DB session_version into a fresh-login token after a bump', async () => {
        mocks.handleTeslaCallback.mockResolvedValue({
            status: 'success',
            siteIds: ['site-1'],
            roles: ['user'],
            userId: 'user-123'
        });
        mocks.getCookie.mockReturnValue(undefined);
        mocks.getAuthState.mockResolvedValueOnce({ isActive: true, sessionVersion: 4, roles: ['user'] });

        const req = new NextRequest('http://localhost:5173/auth/tesla-callback?code=abc&state=xyz');
        await expect(GET(req)).rejects.toMatchObject({ digest: expect.stringContaining('NEXT_REDIRECT;') });

        expect(mocks.signSiteToken).toHaveBeenCalledWith(['site-1'], ['user'], 'user-123', undefined, 4);
    });

    it('does not set site_auth when success result has no sites and no admin role', async () => {
        mocks.handleTeslaCallback.mockResolvedValue({
            status: 'success',
            siteIds: [],
            roles: [],
            userId: 'user-123'
        });

        const req = new NextRequest('http://localhost:5173/auth/tesla-callback?code=abc&state=xyz');
        await expect(GET(req)).rejects.toMatchObject({ digest: expect.stringContaining('NEXT_REDIRECT;') });

        expect(mocks.cookieSet).not.toHaveBeenCalledWith('site_auth', expect.any(String), expect.any(Object));
        expect(mocks.cookieDelete).toHaveBeenCalledWith('auth_state');
        expect(mocks.redirect).toHaveBeenCalledWith('/');
    });

    it('redirects to saved callback only when it is safe relative path', async () => {
        mocks.handleTeslaCallback.mockResolvedValue({
            status: 'success',
            siteIds: ['site-1'],
            roles: [],
            userId: 'user-123'
        });

        // Test safe path
        mocks.getCookie.mockImplementation((name: string) => name === 'auth_callback' ? { value: '/dashboard' } : undefined);
        const req1 = new NextRequest('http://localhost:5173/auth/tesla-callback?code=abc&state=xyz');
        await expect(GET(req1)).rejects.toMatchObject({ digest: expect.stringContaining('NEXT_REDIRECT;') });
        expect(mocks.redirect).toHaveBeenCalledWith('/dashboard');

        // Test unsafe path falls back to '/'
        vi.clearAllMocks();
        mocks.getCookie.mockImplementation((name: string) => name === 'auth_callback' ? { value: '//evil.com' } : undefined);
        const req2 = new NextRequest('http://localhost:5173/auth/tesla-callback?code=abc&state=xyz');
        await expect(GET(req2)).rejects.toMatchObject({ digest: expect.stringContaining('NEXT_REDIRECT;') });
        expect(mocks.redirect).toHaveBeenCalledWith('/');
    });

    it('redirects native login to the fixed callback using only an opaque code and state', async () => {
        mocks.handleTeslaCallback.mockResolvedValue({
            status: 'success', siteIds: ['site-1'], roles: ['user'], userId: 'user-123',
        });
        const mobileCookies: Record<string, string> = {
            auth_mobile_attempt: '9b47b05a-3f0b-498e-b604-9e43fa7df015',
            auth_mobile_challenge: 'A'.repeat(43),
            auth_mobile_state: 'B'.repeat(32),
        };
        mocks.getCookie.mockImplementation((name: string) => mobileCookies[name]
            ? { value: mobileCookies[name] }
            : undefined);

        const response = await GET(new NextRequest('https://pwusage.test/auth/tesla-callback?code=tesla-code&state=xyz'));
        const location = response.headers.get('location') || '';
        expect(location).toMatch(/^pwusage:\/\/auth\/callback\?/);
        expect(location).toContain('code=opaque-handoff-code');
        expect(location).toContain('attempt=9b47b05a-3f0b-498e-b604-9e43fa7df015');
        expect(location).toContain('state=' + 'B'.repeat(32));
        expect(location).not.toContain('site_auth');
        expect(location).not.toContain('tesla-code');
        expect(mocks.cookieSet).not.toHaveBeenCalledWith('site_auth', expect.any(String), expect.any(Object));
        expect(mocks.createMobileLoginHandoff).toHaveBeenCalledWith(expect.objectContaining({
            userId: 'user-123', siteIds: ['site-1'], codeChallenge: 'A'.repeat(43),
        }));
        expect(response.headers.get('cache-control')).toContain('no-store');
    });

    it('clears transient login cookies on native no-site outcomes', async () => {
        mocks.handleTeslaCallback.mockResolvedValue({
            status: 'success', siteIds: [], roles: [], userId: 'user-123',
        });
        const mobileCookies: Record<string, string> = {
            auth_mobile_attempt: '9b47b05a-3f0b-498e-b604-9e43fa7df015',
            auth_mobile_challenge: 'A'.repeat(43),
            auth_mobile_state: 'B'.repeat(32),
        };
        mocks.getCookie.mockImplementation((name: string) => mobileCookies[name]
            ? { value: mobileCookies[name] }
            : undefined);

        const response = await GET(new NextRequest('https://pwusage.test/auth/tesla-callback?code=tesla-code&state=xyz'));
        expect(response.headers.get('location')).toContain('error=no_sites');
        expect(mocks.cookieDelete).toHaveBeenCalledWith('auth_mobile_attempt');
        expect(mocks.cookieDelete).toHaveBeenCalledWith('auth_state');
        expect(mocks.cookieSet).not.toHaveBeenCalledWith('site_auth', expect.any(String), expect.any(Object));
    });

    it('clears transient login cookies when OAuth state validation fails', async () => {
        mocks.handleTeslaCallback.mockResolvedValue({ status: 'state-mismatch' });
        const mobileCookies: Record<string, string> = {
            auth_mobile_attempt: '9b47b05a-3f0b-498e-b604-9e43fa7df015',
            auth_mobile_challenge: 'A'.repeat(43),
            auth_mobile_state: 'B'.repeat(32),
        };
        mocks.getCookie.mockImplementation((name: string) => mobileCookies[name]
            ? { value: mobileCookies[name] }
            : undefined);

        const response = await GET(new NextRequest('https://pwusage.test/auth/tesla-callback?code=tesla-code&state=wrong'));
        expect(response.headers.get('location')).toContain('error=state_mismatch');
        expect(response.headers.get('location')).toContain('state=' + 'B'.repeat(32));
        expect(mocks.cookieDelete).toHaveBeenCalledWith('auth_mobile_attempt');
        expect(mocks.cookieDelete).toHaveBeenCalledWith('auth_state');
    });

    it.each([
        ['Tesla denial', '?error=access_denied&state=xyz', 'access_denied'],
        ['missing code', '?state=xyz', 'missing_code_or_state'],
    ])('returns mobile login to the app after %s', async (_case, query, expectedError) => {
        mocks.getCookie.mockImplementation((name: string) => name === 'auth_mobile_state'
            ? { value: 'B'.repeat(32) }
            : undefined);

        const response = await GET(new NextRequest(`https://pwusage.test/auth/tesla-callback${query}`));
        const location = response.headers.get('location') || '';
        expect(location).toMatch(/^pwusage:\/\/auth\/callback\?/);
        expect(location).toContain(`error=${expectedError}`);
        expect(location).toContain('state=' + 'B'.repeat(32));
        expect(mocks.cookieDelete).toHaveBeenCalledWith('auth_mobile_state');
        expect(mocks.handleTeslaCallback).not.toHaveBeenCalled();
    });

    it.each([
        ['token-exchange-failed', 'token_exchange_failed'],
        ['invalid-id-token', 'invalid_id_token'],
        ['nonce-mismatch', 'nonce_mismatch'],
        ['db-error', 'login_unavailable'],
        ['fleet-api-failed', 'product_import_failed'],
    ])('returns mobile login to the app after %s', async (status, expectedError) => {
        mocks.handleTeslaCallback.mockResolvedValue({ status, statusCode: 502 });
        const mobileCookies: Record<string, string> = {
            auth_mobile_attempt: '9b47b05a-3f0b-498e-b604-9e43fa7df015',
            auth_mobile_challenge: 'A'.repeat(43),
            auth_mobile_state: 'B'.repeat(32),
        };
        mocks.getCookie.mockImplementation((name: string) => mobileCookies[name]
            ? { value: mobileCookies[name] }
            : undefined);

        const response = await GET(new NextRequest('https://pwusage.test/auth/tesla-callback?code=tesla-code&state=xyz'));
        expect(response.headers.get('location')).toContain(`error=${expectedError}`);
        expect(response.headers.get('location')).toContain('state=' + 'B'.repeat(32));
    });

    it('returns to the fixed app callback without a code if handoff persistence fails', async () => {
        mocks.handleTeslaCallback.mockResolvedValue({
            status: 'success', siteIds: ['site-1'], roles: ['user'], userId: 'user-123',
        });
        mocks.createMobileLoginHandoff.mockRejectedValueOnce(new Error('database unavailable'));
        const mobileCookies: Record<string, string> = {
            auth_mobile_attempt: '9b47b05a-3f0b-498e-b604-9e43fa7df015',
            auth_mobile_challenge: 'A'.repeat(43),
            auth_mobile_state: 'B'.repeat(32),
        };
        mocks.getCookie.mockImplementation((name: string) => mobileCookies[name]
            ? { value: mobileCookies[name] }
            : undefined);

        const response = await GET(new NextRequest('https://pwusage.test/auth/tesla-callback?code=tesla-code&state=xyz'));
        const location = response.headers.get('location') || '';
        expect(location).toContain('error=login_unavailable');
        expect(location).not.toContain('code=');
        expect(mocks.cookieDelete).toHaveBeenCalledWith('auth_mobile_attempt');
    });
});

// Exercise both real route handlers against one browser cookie jar. The auth-service
// stub checks continuity, leaving Tesla HTTP calls and DB provisioning out of this test.
import { GET as loginGET } from '@/app/login/route';
import { loginAttemptCookieName } from '@/lib/tesla-login-attempt';

describe('overlapping login attempts', () => {
    const jar = new Map<string, string>();
    beforeEach(() => {
        vi.clearAllMocks();
        jar.clear();
        vi.stubEnv('VERCEL_ENV', 'preview');
        vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://pwusage.test');
        vi.stubEnv('PUBLIC_TESLA_OAUTH_CLIENT_ID', 'client');
        vi.stubEnv('TESLA_OAUTH_SECRET', 'secret');
        mocks.cookieDelete.mockImplementation((name: string) => { jar.delete(name); });
        mocks.cookieSet.mockImplementation((name: string, value: string) => { jar.set(name, value); });
        mocks.getCookie.mockImplementation((name: string) => jar.has(name) ? { value: jar.get(name) } : undefined);
        mocks.cookies.mockResolvedValue({
            get: mocks.getCookie, set: mocks.cookieSet, delete: mocks.cookieDelete,
            getAll: () => [...jar].map(([name, value]) => ({ name, value })),
        });
        mocks.handleTeslaCallback.mockImplementation(async (params: {
            state: string; savedState: string; savedNonce: string; code: string;
        }) => {
            if (params.state !== params.savedState) return { status: 'state-mismatch' };
            // The fixture code stands for an ID token carrying the attempt's nonce.
            if (params.code !== params.savedNonce) return { status: 'nonce-mismatch' };
            return { status: 'success', siteIds: ['site-1'], roles: ['user'], userId: 'user-123' };
        });
    });
    afterEach(() => {
        vi.unstubAllEnvs();
        mocks.cookieDelete.mockReset();
        mocks.cookieSet.mockReset();
        mocks.getCookie.mockReset();
        mocks.handleTeslaCallback.mockReset();
    });

    async function start(query: string) {
        await expect(loginGET(new NextRequest(`https://pwusage.test/login${query}`))).rejects.toMatchObject({
            digest: expect.stringContaining('NEXT_REDIRECT;'),
        });
        const authorize = new URL(mocks.redirect.mock.calls.at(-1)?.[0] as string);
        return { state: authorize.searchParams.get('state') ?? '', code: authorize.searchParams.get('nonce') ?? '' };
    }
    const callback = (attempt: { state: string; code: string }) => GET(new NextRequest(
        `https://pwusage.test/auth/tesla-callback?${new URLSearchParams(attempt)}`,
    ));

    it.each([[0, 1], [1, 0]])('completes web attempts in order %s then %s with their own return destinations', async (first, second) => {
        const attempts = [await start('?callback=/one'), await start('?callback=/two')];
        for (const index of [first, second]) {
            await expect(callback(attempts[index])).rejects.toMatchObject({ digest: expect.stringContaining('NEXT_REDIRECT;') });
            expect(mocks.redirect).toHaveBeenLastCalledWith(index === 0 ? '/one' : '/two');
        }
        expect(jar.has('site_auth')).toBe(true);
        expect([...jar.keys()].filter(name => name.startsWith('auth_attempt_'))).toEqual([]);
    });

    it('keeps mobile PKCE metadata when a web login starts and completes in the same browser', async () => {
        const mobile = await start(`?mobile_challenge=${'A'.repeat(43)}&mobile_state=${'B'.repeat(32)}`);
        const web = await start('?callback=/web');
        await expect(callback(web)).rejects.toMatchObject({ digest: expect.stringContaining('NEXT_REDIRECT;') });
        const response = await callback(mobile);
        expect(response.headers.get('location')).toContain('code=opaque-handoff-code');
        expect(mocks.createMobileLoginHandoff).toHaveBeenCalledWith(expect.objectContaining({
            codeChallenge: 'A'.repeat(43), appState: 'B'.repeat(32),
        }));
    });

    it('does not clear a second attempt when the first fails nonce validation', async () => {
        const first = await start('');
        const second = await start('?callback=/two');
        const failed = await callback({ ...first, code: 'wrong-nonce' });
        expect(failed.status).toBe(401);
        expect(jar.has(loginAttemptCookieName(second.state) ?? '')).toBe(true);
        await expect(callback(second)).rejects.toMatchObject({ digest: expect.stringContaining('NEXT_REDIRECT;') });
        expect(mocks.redirect).toHaveBeenLastCalledWith('/two');
    });

    it('never falls back to unrelated legacy mobile metadata for a missing v2 attempt', async () => {
        jar.set('auth_state', 'legacy-state');
        jar.set('auth_mobile_state', 'B'.repeat(32));
        const missing = await callback({ state: 'v2.' + 'a'.repeat(32), code: 'unused' });
        expect(missing.status).toBe(401);
        expect(missing.headers.get('location')).toBeNull();
        expect(jar.get('auth_state')).toBe('legacy-state');
        expect(jar.get('auth_mobile_state')).toBe('B'.repeat(32));
        expect(mocks.handleTeslaCallback).toHaveBeenCalledWith(expect.objectContaining({ savedState: '', savedNonce: '' }));
    });

    it('consumes only a denied attempt and leaves another attempt usable', async () => {
        const denied = await start('');
        const second = await start('');
        const response = await GET(new NextRequest(`https://pwusage.test/auth/tesla-callback?error=access_denied&state=${denied.state}`));
        expect(response.status).toBe(400);
        expect(jar.has(loginAttemptCookieName(denied.state) ?? '')).toBe(false);
        expect(jar.has(loginAttemptCookieName(second.state) ?? '')).toBe(true);
    });

    it('keeps two native handoffs bound to their own PKCE challenge and app state', async () => {
        const first = await start(`?mobile_challenge=${'A'.repeat(43)}&mobile_state=${'B'.repeat(32)}`);
        const second = await start(`?mobile_challenge=${'C'.repeat(43)}&mobile_state=${'D'.repeat(32)}`);
        for (const [attempt, challenge, appState] of [
            [second, 'C'.repeat(43), 'D'.repeat(32)],
            [first, 'A'.repeat(43), 'B'.repeat(32)],
        ] as const) {
            const response = await callback(attempt);
            expect(response.headers.get('location')).toContain(`state=${appState}`);
            expect(mocks.createMobileLoginHandoff).toHaveBeenLastCalledWith(expect.objectContaining({
                codeChallenge: challenge, appState,
            }));
        }
    });

    it('rejects an expired attempt without trusting legacy cookies', async () => {
        const attempt = await start('');
        const name = loginAttemptCookieName(attempt.state) ?? '';
        const data = JSON.parse(jar.get(name) ?? '{}') as Record<string, unknown>;
        jar.set(name, JSON.stringify({ ...data, expiresAt: Date.now() - 1 }));
        jar.set('auth_state', attempt.state);
        expect((await callback(attempt)).status).toBe(401);
        expect(jar.has(name)).toBe(false);
        expect(jar.get('auth_state')).toBe(attempt.state);
    });

    it('ignores speculative callback requests without consuming an attempt', async () => {
        const attempt = await start('');
        mocks.cookies.mockClear();
        const response = await GET(new NextRequest(
            `https://pwusage.test/auth/tesla-callback?${new URLSearchParams(attempt)}`,
            { headers: { 'next-router-prefetch': '1' } },
        ));
        expect(response.status).toBe(204);
        expect(mocks.cookies).not.toHaveBeenCalled();
        expect(jar.has(loginAttemptCookieName(attempt.state) ?? '')).toBe(true);
    });

    it('redirects a production callback alias before reading or consuming cookies', async () => {
        vi.stubEnv('VERCEL_ENV', 'production');
        const response = await GET(new NextRequest('https://alias.vercel.app/auth/tesla-callback?code=abc&state=xyz'));
        expect(response.headers.get('location')).toBe('https://pwusage.fm.rodeo/auth/tesla-callback?code=abc&state=xyz');
        expect(mocks.cookies).not.toHaveBeenCalled();
    });
});
