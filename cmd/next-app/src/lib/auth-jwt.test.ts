import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { checkRefreshNeeded, signSiteToken, verifySiteToken } from './auth-jwt';

const { rejectionLog } = vi.hoisted(() => ({ rejectionLog: vi.fn() }));
vi.mock('./observability', () => ({ logSessionRejection: rejectionLog }));

const mockGetById = vi.fn();
const mockGetSitesForUser = vi.fn();

// Mock user-repo and site-repo so the refresh path's claim re-derivation and revocation checks
// are controllable and never touch the real pg pool / database.
vi.mock('./user-repo', () => {
    return {
        UserRepo: class {
            getById(id: string) {
                return mockGetById(id);
            }
        },
        isUserActive: vi.fn(),
    };
});

vi.mock('./site-repo', () => {
    return {
        SiteRepo: class {
            getSitesForUser(id: string) {
                return mockGetSitesForUser(id);
            }
        },
    };
});

// In tests NODE_ENV !== 'production', so auth-jwt falls back to this default
// secret (see getAuthSecret in auth-jwt.ts). We sign fixtures with the same
// value so checkRefreshNeeded can verify them.
const TEST_SECRET = 'default-dev-secret-do-not-use-in-prod';
const DAY = 24 * 60 * 60;

it('distinguishes expired sessions from invalid signatures without logging their values', () => {
    rejectionLog.mockClear();
    const expired = jwt.sign({ sites: ['s1'] }, TEST_SECRET, { expiresIn: -1 });
    expect(verifySiteToken(expired)).toBeNull();
    expect(rejectionLog).toHaveBeenLastCalledWith('expired-session');
    expect(verifySiteToken('malformed')).toBeNull();
    expect(rejectionLog).toHaveBeenLastCalledWith('invalid-session');
});

function nowSeconds() {
    return Math.floor(Date.now() / 1000);
}

describe('verifySiteToken', () => {
    it('accepts the HS256 tokens signSiteToken issues', () => {
        const token = signSiteToken(['s1'], ['user'], 'u1');
        expect(verifySiteToken(token)).toMatchObject({ sites: ['s1'], roles: ['user'], sub: 'u1' });
    });

    it('embeds and verifies the session_version (sv) claim', () => {
        const token = signSiteToken(['s1'], ['user'], 'u1', undefined, 3);
        expect(verifySiteToken(token)).toMatchObject({ sites: ['s1'], roles: ['user'], sub: 'u1', sv: 3 });
    });

    it('defaults sv to 0 when signing without an explicit session version', () => {
        const token = signSiteToken(['s1'], ['user'], 'u1');
        expect(verifySiteToken(token)?.sv).toBe(0);
    });

    it('verifies a legacy token without an sv claim and reports sv as undefined', () => {
        const legacy = jwt.sign({ sites: ['s1'], roles: ['user'], sub: 'u1', orig_iat: nowSeconds() }, TEST_SECRET, {
            expiresIn: 60,
        });
        const decoded = verifySiteToken(legacy);
        expect(decoded).toMatchObject({ sites: ['s1'], roles: ['user'], sub: 'u1' });
        expect(decoded?.sv).toBeUndefined();
    });

    // Pinning the accepted algorithm keeps a future key-type change from reopening
    // algorithm confusion. These tokens are only ever minted as HS256.
    it('rejects a token signed with a different HMAC algorithm', () => {
        const token = jwt.sign({ sites: ['s1'], roles: ['user'], sub: 'u1' }, TEST_SECRET, {
            algorithm: 'HS384',
            expiresIn: 60,
        });
        expect(verifySiteToken(token)).toBeNull();
    });
});

describe('checkRefreshNeeded', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetById.mockResolvedValue({ id: 'u1', is_active: true, roles: ['user'], session_version: 0 });
        mockGetSitesForUser.mockResolvedValue([{ id: 's1' }]);
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
        expect(claims?.roles).toEqual(['user']);
    });

    it('re-derives roles and sites from DB when refreshing token (fixes stale claims vulnerability)', async () => {
        // Token claims indicate admin role and access to s1 and s2
        const expiringSoon = jwt.sign(
            { sites: ['s1', 's2'], roles: ['admin'], sub: 'u1', orig_iat: nowSeconds() },
            TEST_SECRET,
            { expiresIn: 60 }
        );

        // DB state shows user was demoted to 'user' role and s2 was unassigned
        mockGetById.mockResolvedValue({ id: 'u1', is_active: true, roles: ['user'], session_version: 0 });
        mockGetSitesForUser.mockResolvedValue([{ id: 's1' }]);

        const refreshed = await checkRefreshNeeded(expiringSoon);

        expect(refreshed).toBeTruthy();
        const claims = verifySiteToken(refreshed!);
        expect(claims?.sub).toBe('u1');
        expect(claims?.roles).toEqual(['user']); // Admin role demoted
        expect(claims?.sites).toEqual(['s1']);   // Stale site s2 removed
    });

    it('stamps the DB session_version into the refreshed token', async () => {
        mockGetById.mockResolvedValue({ id: 'u1', is_active: true, roles: ['user'], session_version: 2 });
        mockGetSitesForUser.mockResolvedValue([{ id: 's1' }]);

        const expiringSoon = jwt.sign(
            { sites: ['s1'], roles: ['user'], sub: 'u1', sv: 2, orig_iat: nowSeconds() },
            TEST_SECRET,
            { expiresIn: 60 }
        );

        const refreshed = await checkRefreshNeeded(expiringSoon);

        expect(refreshed).toBeTruthy();
        expect(verifySiteToken(refreshed!)?.sv).toBe(2);
    });

    // A token whose sv is behind the DB session_version was revoked by
    // sign-out-everywhere. Refresh must NOT re-stamp the new sv — that would
    // auto-un-revoke a stolen/old session on its next refresh window.
    it('refuses to refresh a session revoked by a session_version bump', async () => {
        mockGetById.mockResolvedValue({ id: 'u1', is_active: true, roles: ['user'], session_version: 1 });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const revokedToken = jwt.sign(
            { sites: ['s1'], roles: ['user'], sub: 'u1', sv: 0, orig_iat: nowSeconds() },
            TEST_SECRET,
            { expiresIn: 60 }
        );

        expect(await checkRefreshNeeded(revokedToken)).toBeNull();
        expect(warn).toHaveBeenCalled();
    });

    it('treats a legacy token without sv as version 0 and refuses refresh once the DB version is bumped', async () => {
        mockGetById.mockResolvedValue({ id: 'u1', is_active: true, roles: ['user'], session_version: 1 });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const legacyToken = jwt.sign(
            { sites: ['s1'], roles: ['user'], sub: 'u1', orig_iat: nowSeconds() },
            TEST_SECRET,
            { expiresIn: 60 }
        );

        expect(await checkRefreshNeeded(legacyToken)).toBeNull();
        expect(warn).toHaveBeenCalled();
    });

    it('gracefully migrates a legacy token (no sv) to the current DB version when it is still 0', async () => {
        mockGetById.mockResolvedValue({ id: 'u1', is_active: true, roles: ['user'], session_version: 0 });
        mockGetSitesForUser.mockResolvedValue([{ id: 's1' }]);

        const legacyToken = jwt.sign(
            { sites: ['s1'], roles: ['user'], sub: 'u1', orig_iat: nowSeconds() },
            TEST_SECRET,
            { expiresIn: 60 }
        );

        const refreshed = await checkRefreshNeeded(legacyToken);

        expect(refreshed).toBeTruthy();
        expect(verifySiteToken(refreshed!)?.sv).toBe(0);
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
    // user status keep honoring the cookie until the 30-day absolute cap.
    it('refuses to refresh and warns when the user has been revoked/deactivated', async () => {
        mockGetById.mockResolvedValue({ id: 'revoked-user', is_active: false, roles: ['user'] });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const expiringSoon = jwt.sign(
            { sites: ['s1'], roles: ['user'], sub: 'revoked-user', orig_iat: nowSeconds() },
            TEST_SECRET,
            { expiresIn: 60 }
        );

        expect(await checkRefreshNeeded(expiringSoon)).toBeNull();
        expect(mockGetById).toHaveBeenCalledWith('revoked-user');
        expect(warn).toHaveBeenCalled();
    });

    // Parity with UserRepo.isActive(), which requires is_active === true: a NULL
    // is_active (column is nullable BOOLEAN DEFAULT TRUE) must be treated as
    // inactive here too, not silently promoted to active.
    it('refuses to refresh when is_active is NULL', async () => {
        mockGetById.mockResolvedValue({ id: 'null-active-user', is_active: null, roles: ['user'] });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const expiringSoon = jwt.sign(
            { sites: ['s1'], roles: ['user'], sub: 'null-active-user', orig_iat: nowSeconds() },
            TEST_SECRET,
            { expiresIn: 60 }
        );

        expect(await checkRefreshNeeded(expiringSoon)).toBeNull();
        expect(mockGetById).toHaveBeenCalledWith('null-active-user');
        expect(warn).toHaveBeenCalled();
    });

    it('refuses to refresh and warns when the user is not found in DB', async () => {
        mockGetById.mockResolvedValue(null);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const expiringSoon = jwt.sign(
            { sites: ['s1'], roles: ['user'], sub: 'deleted-user', orig_iat: nowSeconds() },
            TEST_SECRET,
            { expiresIn: 60 }
        );

        expect(await checkRefreshNeeded(expiringSoon)).toBeNull();
        expect(mockGetById).toHaveBeenCalledWith('deleted-user');
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
