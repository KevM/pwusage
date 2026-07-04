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

import { GET } from './route';

describe('GET /auth/tesla-callback', () => {
    const origEnv = process.env;

    beforeEach(() => {
        vi.clearAllMocks();
        process.env = {
            ...origEnv,
            PUBLIC_TESLA_OAUTH_CLIENT_ID: 'client-123',
            PUBLIC_TESLA_OAUTH_AUDIENCE: 'https://fleet-api.prd.na.vn.cloud.tesla.com'
        };

        mocks.cookies.mockResolvedValue({
            get: mocks.getCookie,
            set: mocks.cookieSet,
            delete: mocks.cookieDelete
        });
    });

    afterEach(() => {
        process.env = origEnv;
    });

    it('returns 500 when environment variables are missing', async () => {
        delete process.env.PUBLIC_TESLA_OAUTH_CLIENT_ID;

        const req = new NextRequest('http://localhost:5173/auth/tesla-callback?code=abc&state=xyz');
        const res = await GET(req);
        expect(res.status).toBe(500);
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
            { status: 'nonce-mismatch', expectedHttp: 401 }
        ];

        for (const failure of failureCases) {
            vi.clearAllMocks();
            mocks.handleTeslaCallback.mockResolvedValue(failure);

            const req = new NextRequest('http://localhost:5173/auth/tesla-callback?code=abc&state=xyz');
            const res = await GET(req);
            expect(res.status).toBe(failure.expectedHttp);
        }
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
});
