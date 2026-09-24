import { beforeEach, describe, expect, it, vi } from 'vitest';
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

import { GET } from './route';

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
});
