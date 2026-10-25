import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
    cookies: vi.fn(),
    redirect: vi.fn(),
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
            PUBLIC_TESLA_OAUTH_AUDIENCE: 'https://fleet-api.prd.na.vn.cloud.tesla.com',
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

    // handleTeslaCallback reads all three via requireEnv and throws on a missing
    // one, so without this check a deploy missing TESLA_OAUTH_SECRET would
    // surface as an unhandled throw (raw 500 from Next) rather than this route's
    // own JSON. Asserted per-variable so adding a fourth cannot silently skip it.
    it.each([
        'PUBLIC_TESLA_OAUTH_CLIENT_ID',
        'PUBLIC_TESLA_OAUTH_AUDIENCE',
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
    // the exact misleading outcome this guard exists to prevent. Same three
    // variables as the missing-var case above, so a fourth cannot skip this.
    it.each([
        'PUBLIC_TESLA_OAUTH_CLIENT_ID',
        'PUBLIC_TESLA_OAUTH_AUDIENCE',
        'TESLA_OAUTH_SECRET',
    ])('treats a whitespace-only %s as missing', async (variable) => {
        process.env[variable] = '   ';

        const req = new NextRequest('http://localhost:5173/auth/tesla-callback?code=abc&state=xyz');
        const res = await GET(req);

        expect(res.status).toBe(500);
        expect(await res.json()).toEqual({ error: 'Server misconfigured' });
        expect(mocks.handleTeslaCallback).not.toHaveBeenCalled();
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
        await GET(req);

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
        await GET(req);

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
        await GET(req);

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
        await GET(req1);
        expect(mocks.redirect).toHaveBeenCalledWith('/dashboard');

        // Test unsafe path falls back to '/'
        vi.clearAllMocks();
        mocks.getCookie.mockImplementation((name: string) => name === 'auth_callback' ? { value: '//evil.com' } : undefined);
        const req2 = new NextRequest('http://localhost:5173/auth/tesla-callback?code=abc&state=xyz');
        await GET(req2);
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
