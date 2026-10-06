import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    checkRefreshNeeded: vi.fn(),
}));

vi.mock('./lib/auth-jwt', () => ({
    checkRefreshNeeded: mocks.checkRefreshNeeded,
    COOKIE_MAX_AGE_SECONDS: 86400
}));

import { proxy } from './proxy';
import { NextRequest } from 'next/server';

afterEach(() => { vi.unstubAllEnvs(); });

describe('proxy middleware', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubEnv('NODE_ENV', 'development');
    });

    it('leaves response untouched when no site_auth cookie is present', async () => {
        const req = new NextRequest('http://localhost/dashboard');
        const res = await proxy(req);

        expect(mocks.checkRefreshNeeded).not.toHaveBeenCalled();
        expect(res.cookies.get('site_auth')).toBeUndefined();
    });

    it('leaves response untouched when token does not need refresh', async () => {
        mocks.checkRefreshNeeded.mockResolvedValue(null);

        const req = new NextRequest('http://localhost/dashboard', {
            headers: { cookie: 'site_auth=current-valid-token' }
        });
        const res = await proxy(req);

        expect(mocks.checkRefreshNeeded).toHaveBeenCalledWith('current-valid-token');
        expect(res.cookies.get('site_auth')).toBeUndefined();
    });

    it('refreshes site_auth cookie with httpOnly, sameSite=lax, maxAge, and secure in production', async () => {
        vi.stubEnv('NODE_ENV', 'production');
        mocks.checkRefreshNeeded.mockResolvedValue('refreshed-token-xyz');

        const req = new NextRequest('http://localhost/dashboard', {
            headers: { cookie: 'site_auth=expiring-token' }
        });
        const res = await proxy(req);

        const setCookie = res.cookies.get('site_auth');
        expect(setCookie).toBeDefined();
        expect(setCookie?.value).toBe('refreshed-token-xyz');
        expect(setCookie?.httpOnly).toBe(true);
        expect(setCookie?.sameSite).toBe('lax');
        expect(setCookie?.maxAge).toBe(86400);
        expect(setCookie?.secure).toBe(true);
    });
});
