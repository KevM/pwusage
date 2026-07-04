import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    cookies: vi.fn(),
    verifySiteToken: vi.fn(),
    isUserActive: vi.fn(),
}));

vi.mock('next/headers', () => ({
    cookies: mocks.cookies
}));

vi.mock('./auth-jwt', () => ({
    verifySiteToken: mocks.verifySiteToken
}));

vi.mock('./user-repo', () => ({
    isUserActive: mocks.isUserActive,
    UserRepo: class {}
}));

import { getCurrentUser, verifySiteAccess, getAuthorizedSiteIds, isUserAdmin } from './auth-checks';

describe('auth-checks.ts', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.cookies.mockResolvedValue({
            get: vi.fn((name: string) => name === 'site_auth' ? { value: 'test-jwt-token' } : undefined)
        });
    });

    it('returns null/false/empty array when site_auth cookie is missing or malformed', async () => {
        mocks.cookies.mockResolvedValue({
            get: vi.fn().mockReturnValue(undefined)
        });
        mocks.verifySiteToken.mockReturnValue(null);

        expect(await getCurrentUser()).toBeNull();
        expect(await verifySiteAccess('site-1')).toBe(false);
        expect(await getAuthorizedSiteIds()).toEqual([]);
        expect(await isUserAdmin()).toBe(false);
    });

    it('returns null/false/empty array without throwing when verifySiteToken returns invalid/malformed payload', async () => {
        mocks.verifySiteToken.mockReturnValue(null);

        expect(await getCurrentUser()).toBeNull();
        expect(await verifySiteAccess('site-1')).toBe(false);
        expect(await getAuthorizedSiteIds()).toEqual([]);
        expect(await isUserAdmin()).toBe(false);
    });

    it('blocks getCurrentUser, verifySiteAccess, and getAuthorizedSiteIds when user is inactive/revoked', async () => {
        mocks.verifySiteToken.mockReturnValue({
            sub: 'revoked-user-123',
            sites: ['site-1'],
            roles: ['admin']
        });
        mocks.isUserActive.mockResolvedValue(false);

        expect(await getCurrentUser()).toBeNull();
        expect(await verifySiteAccess('site-1')).toBe(false);
        expect(await getAuthorizedSiteIds()).toEqual([]);
    });

    it('grants access for active user and admin role', async () => {
        mocks.verifySiteToken.mockReturnValue({
            sub: 'active-user-123',
            sites: ['site-1'],
            roles: ['admin']
        });
        mocks.isUserActive.mockResolvedValue(true);

        const user = await getCurrentUser();
        expect(user).toEqual({ id: 'active-user-123' });
        expect(await verifySiteAccess('site-1')).toBe(true);
        expect(await verifySiteAccess('site-other')).toBe(true); // admin has access to any site
        expect(await getAuthorizedSiteIds()).toEqual(['site-1']);
        expect(await isUserAdmin()).toBe(true);
    });

    it('denies site access to admin role if user is inactive/revoked', async () => {
        mocks.verifySiteToken.mockReturnValue({
            sub: 'inactive-admin',
            sites: ['site-1'],
            roles: ['admin']
        });
        mocks.isUserActive.mockResolvedValue(false);

        expect(await verifySiteAccess('site-1')).toBe(false);
    });
});
