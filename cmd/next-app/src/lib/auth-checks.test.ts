import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    cookies: vi.fn(),
    verifySiteToken: vi.fn(),
    getAuthState: vi.fn(),
    getSitesForUser: vi.fn(),
    logSessionRejection: vi.fn(),
}));
vi.mock('./observability', () => ({ logSessionRejection: mocks.logSessionRejection }));

vi.mock('next/headers', () => ({
    cookies: mocks.cookies
}));

vi.mock('./auth-jwt', () => ({
    verifySiteToken: mocks.verifySiteToken
}));

vi.mock('./user-repo', () => ({
    isUserActive: vi.fn(),
    UserRepo: class {
        getAuthState = mocks.getAuthState;
    }
}));

vi.mock('./site-repo', () => ({
    SiteRepo: class {
        getSitesForUser = mocks.getSitesForUser;
    }
}));

import { getCurrentUser, verifySiteAccess, getAuthorizedSiteIds, isUserAdmin, hasValidSession } from './auth-checks';

describe('auth-checks.ts', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.cookies.mockResolvedValue({
            get: vi.fn((name: string) => name === 'site_auth' ? { value: 'test-jwt-token' } : undefined)
        });
        mocks.getAuthState.mockResolvedValue({ isActive: true, sessionVersion: 0, roles: ['user'] });
        mocks.getSitesForUser.mockResolvedValue([{ id: 'site-1' }]);
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
        expect(mocks.logSessionRejection).toHaveBeenCalledWith('missing-cookie');
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
        mocks.getAuthState.mockResolvedValue({ isActive: false, sessionVersion: 0, roles: ['admin'] });

        expect(await getCurrentUser()).toBeNull();
        expect(await verifySiteAccess('site-1')).toBe(false);
        expect(await getAuthorizedSiteIds()).toEqual([]);
        expect(mocks.logSessionRejection).toHaveBeenCalledWith('inactive-account', 'revoked-user-123');
    });

    it('blocks getCurrentUser when the user row no longer exists', async () => {
        mocks.verifySiteToken.mockReturnValue({
            sub: 'deleted-user',
            sites: ['site-1'],
            roles: ['user']
        });
        mocks.getAuthState.mockResolvedValue(null);

        expect(await getCurrentUser()).toBeNull();
        expect(await verifySiteAccess('site-1')).toBe(false);
        expect(await getAuthorizedSiteIds()).toEqual([]);
    });

    it('grants access for active user with DB-derived sites', async () => {
        mocks.verifySiteToken.mockReturnValue({
            sub: 'active-user-123',
            sites: ['stale-site'],
            roles: ['user']
        });
        mocks.getAuthState.mockResolvedValue({ isActive: true, sessionVersion: 0, roles: ['user'] });
        mocks.getSitesForUser.mockResolvedValue([{ id: 'site-1' }]);

        const user = await getCurrentUser();
        expect(user).toEqual({ id: 'active-user-123' });
        expect(await verifySiteAccess('site-1')).toBe(true);
        expect(await getAuthorizedSiteIds()).toEqual(['site-1']);
        expect(await isUserAdmin()).toBe(false);
    });

    // Closing the stale-claims gap: site membership must come from the DB,
    // not the JWT's sites claim, which can outlive an unassignment.
    it('ignores stale site claims in the JWT and authorizes from DB membership', async () => {
        mocks.verifySiteToken.mockReturnValue({
            sub: 'active-user-123',
            sites: ['unassigned-site'],
            roles: ['user']
        });
        mocks.getAuthState.mockResolvedValue({ isActive: true, sessionVersion: 0, roles: ['user'] });
        mocks.getSitesForUser.mockResolvedValue([{ id: 'current-site' }]);

        expect(await verifySiteAccess('unassigned-site')).toBe(false);
        expect(await verifySiteAccess('current-site')).toBe(true);
        expect(await getAuthorizedSiteIds()).toEqual(['current-site']);
    });

    // Stale role claims: admin must be re-derived from the DB too.
    it('ignores stale admin role in the JWT and reads roles from the DB', async () => {
        mocks.verifySiteToken.mockReturnValue({
            sub: 'demoted-user',
            sites: ['site-1'],
            roles: ['admin']
        });
        mocks.getAuthState.mockResolvedValue({ isActive: true, sessionVersion: 0, roles: ['user'] });
        mocks.getSitesForUser.mockResolvedValue([{ id: 'site-1' }]);

        expect(await isUserAdmin()).toBe(false);
        expect(await verifySiteAccess('other-site')).toBe(false);
        expect(await verifySiteAccess('site-1')).toBe(true);
    });

    it('denies site access to admin role if user is inactive/revoked', async () => {
        mocks.verifySiteToken.mockReturnValue({
            sub: 'inactive-admin',
            sites: ['site-1'],
            roles: ['admin']
        });
        mocks.getAuthState.mockResolvedValue({ isActive: false, sessionVersion: 0, roles: ['admin'] });

        expect(await verifySiteAccess('site-1')).toBe(false);
    });

    // Sign-out-everywhere: a token whose sv trails the DB session_version is revoked.
    it('blocks a session whose token sv trails the DB session_version', async () => {
        mocks.verifySiteToken.mockReturnValue({
            sub: 'revoked-session-user',
            sites: ['site-1'],
            roles: ['admin'],
            sv: 0
        });
        mocks.getAuthState.mockResolvedValue({ isActive: true, sessionVersion: 1, roles: ['admin'] });

        expect(await getCurrentUser()).toBeNull();
        expect(await verifySiteAccess('site-1')).toBe(false);
        expect(await getAuthorizedSiteIds()).toEqual([]);
        expect(await isUserAdmin()).toBe(false);
    });

    it('allows a session whose token sv matches the DB session_version', async () => {
        mocks.verifySiteToken.mockReturnValue({
            sub: 'current-session-user',
            sites: ['site-1'],
            roles: ['user'],
            sv: 2
        });
        mocks.getAuthState.mockResolvedValue({ isActive: true, sessionVersion: 2, roles: ['user'] });

        expect(await getCurrentUser()).toEqual({ id: 'current-session-user' });
        expect(await verifySiteAccess('site-1')).toBe(true);
    });

    // Legacy tokens without `sv` are treated as version 0: valid while the DB
    // version is still 0, revoked once it has been bumped.
    it('treats a legacy token without sv as version 0 and blocks it after a version bump', async () => {
        mocks.verifySiteToken.mockReturnValue({
            sub: 'legacy-user',
            sites: ['site-1'],
            roles: ['user']
        });

        mocks.getAuthState.mockResolvedValue({ isActive: true, sessionVersion: 0, roles: ['user'] });
        expect(await getCurrentUser()).toEqual({ id: 'legacy-user' });

        mocks.getAuthState.mockResolvedValue({ isActive: true, sessionVersion: 1, roles: ['user'] });
        expect(await getCurrentUser()).toBeNull();
        expect(await verifySiteAccess('site-1')).toBe(false);
    });

    it('hasValidSession is false for a revoked session and true for a current one', async () => {
        mocks.verifySiteToken.mockReturnValue({ sub: 'user-1', sites: ['site-1'], roles: ['user'], sv: 0 });

        mocks.getAuthState.mockResolvedValue({ isActive: true, sessionVersion: 1, roles: ['user'] });
        expect(await hasValidSession()).toBe(false);

        mocks.getAuthState.mockResolvedValue({ isActive: true, sessionVersion: 0, roles: ['user'] });
        expect(await hasValidSession()).toBe(true);
    });

    it('hasValidSession is true for a car-only user with no sites', async () => {
        mocks.verifySiteToken.mockReturnValue({ sub: 'car-user', sites: [], roles: ['user'], sv: 0 });
        mocks.getSitesForUser.mockResolvedValue([]);

        expect(await hasValidSession()).toBe(true);
        expect(await getAuthorizedSiteIds()).toEqual([]);
    });
});
