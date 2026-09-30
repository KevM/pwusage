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

import { buildTeslaAuthorizeUrl, GET } from './route';

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

    it('fails loudly instead of redirecting when PUBLIC_TESLA_OAUTH_CLIENT_ID is unset', async () => {
        vi.stubEnv('PUBLIC_TESLA_OAUTH_CLIENT_ID', '');
        const req = new NextRequest('http://localhost:5173/login');

        await expect(GET(req)).rejects.toThrow(/PUBLIC_TESLA_OAUTH_CLIENT_ID/);
        expect(mocks.redirect).not.toHaveBeenCalled();
    });
});

/** Reads a query parameter's raw (still percent-encoded) value out of a URL. */
function rawQueryValue(url: string, key: string): string | undefined {
    return new URL(url).search.match(new RegExp(`[?&]${key}=([^&]*)`))?.[1];
}

describe('buildTeslaAuthorizeUrl', () => {
    const baseParams = {
        state: 'state-123',
        nonce: 'nonce-456',
        callbackUrl: 'https://pwusage.fm.rodeo/auth/tesla-callback',
        clientId: 'client-id-123',
    };

    // Asserted by exact equality rather than a pile of toContain calls: equality
    // also catches a dropped parameter, an extra parameter, and any encoding
    // drift, none of which independent substring checks would notice. Parameter
    // order is not load-bearing -- OAuth consumers treat the query as a set.
    it('encodes the complete authorize URL exactly, in a stable order', () => {
        expect(buildTeslaAuthorizeUrl(baseParams)).toBe(
            'https://auth.tesla.com/oauth2/v3/authorize?locale=en-US&response_type=code'
            + '&scope=openid%20energy_device_data%20offline_access%20user_data%20energy_cmds'
            + '&state=state-123'
            + '&redirect_uri=https%3A%2F%2Fpwusage.fm.rodeo%2Fauth%2Ftesla-callback'
            + '&client_id=client-id-123'
            + '&nonce=nonce-456'
            + '&prompt_missing_scopes=true'
        );
    });

    // `state-123` and `nonce-456` need no escaping, so they cannot catch a
    // regression in the encoding itself. These values exercise every character
    // class the old string interpolation dropped on the floor.
    describe('encoding reserved characters', () => {
        const reservedParams = {
            state: 'st+ate/va=lue here',
            nonce: 'no+nce/va=lue here',
            callbackUrl: baseParams.callbackUrl,
            clientId: baseParams.clientId,
        };

        it('escapes +, / and = instead of passing them through raw', () => {
            expect(rawQueryValue(buildTeslaAuthorizeUrl(reservedParams), 'state'))
                .toBe('st%2Bate%2Fva%3Dlue%20here');
        });

        // Scoped to the nonce value rather than the whole URL: a blanket
        // not.toContain('+') would also fail for an unrelated reason if an input
        // ever legitimately carried a literal '+'.
        it('encodes the space as %20, which URLSearchParams.toString() would emit as +', () => {
            const rawNonce = rawQueryValue(buildTeslaAuthorizeUrl(reservedParams), 'nonce');

            expect(rawNonce).toBe('no%2Bnce%2Fva%3Dlue%20here');
            expect(rawNonce).toContain('%20');
            expect(rawNonce).not.toContain('+');
        });
    });
});
