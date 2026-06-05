import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { checkRefreshNeeded, signSiteToken, verifySiteToken } from './auth-jwt';
import { isUserActive } from './user-repo';

// Mock user-repo so the refresh path's revocation check is controllable and never
// touches the real pg pool / database.
vi.mock('./user-repo', () => ({
    isUserActive: vi.fn().mockResolvedValue(true),
}));
const isUserActiveMock = vi.mocked(isUserActive);

// In tests NODE_ENV !== 'production', so auth-jwt falls back to this default
// secret (see getAuthSecret in auth-jwt.ts). We sign fixtures with the same
// value so checkRefreshNeeded can verify them.
const TEST_SECRET = 'default-dev-secret-do-not-use-in-prod';
const DAY = 24 * 60 * 60;

function nowSeconds() {
    return Math.floor(Date.now() / 1000);
}

describe('checkRefreshNeeded', () => {
    beforeEach(() => {
        isUserActiveMock.mockResolvedValue(true);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('refreshes a token that is within the 24h refresh window for an active user', async () => {
        const expiringSoon = jwt.sign(
            { sites: ['s1'], roles: ['user'], sub: 'u1', orig_iat: nowSeconds() },
            TEST_SECRET,
            { expiresIn: 60 } // 60s remaining < 24h threshold
        );

        const refreshed = await checkRefreshNeeded(expiringSoon);

        expect(refreshed).toBeTruthy();
        expect(refreshed).not.toBe(expiringSoon);
        const claims = verifySiteToken(refreshed!);
        expect(claims?.sub).toBe('u1');
        expect(claims?.sites).toEqual(['s1']);
    });

    it('does not refresh a freshly issued token (outside the window)', async () => {
        const fresh = signSiteToken(['s1'], ['user'], 'u1'); // 7-day expiry
        expect(await checkRefreshNeeded(fresh)).toBeNull();
    });

    it('refuses to refresh once the absolute session cap is exceeded', async () => {
        const stale = jwt.sign(
            { sites: ['s1'], roles: ['user'], sub: 'u1', orig_iat: nowSeconds() - 31 * DAY },
            TEST_SECRET,
            { expiresIn: 60 } // would otherwise be inside the refresh window
        );
        expect(await checkRefreshNeeded(stale)).toBeNull();
    });

    // Security regression guard (Codex P1): a revoked/inactive user must not have
    // their session extended, otherwise JWT-only authz paths that don't recheck
    // isUserActive (e.g. SiteService.validateSiteAccess) keep honoring the cookie
    // until the 30-day absolute cap instead of the next normal expiry.
    it('refuses to refresh and warns when the user has been revoked', async () => {
        isUserActiveMock.mockResolvedValue(false);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const expiringSoon = jwt.sign(
            { sites: ['s1'], roles: ['user'], sub: 'revoked-user', orig_iat: nowSeconds() },
            TEST_SECRET,
            { expiresIn: 60 }
        );

        expect(await checkRefreshNeeded(expiringSoon)).toBeNull();
        expect(isUserActiveMock).toHaveBeenCalledWith('revoked-user');
        expect(warn).toHaveBeenCalled();
    });

    // Instrumentation: the catch must surface verification failures instead of
    // swallowing them silently (that silence hid the original refresh regression).
    it('returns null and logs a warning on a malformed token', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(await checkRefreshNeeded('not.a.valid.jwt')).toBeNull();
        expect(warn).toHaveBeenCalled();
    });
});
