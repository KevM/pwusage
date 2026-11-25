import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockQuery = vi.fn();
const mockClientQuery = vi.fn();
const mockClientRelease = vi.fn();
const mockConnect = vi.fn();
const mockSiteMembershipEnabled = vi.fn(() => true);

vi.mock('../db', () => ({
    pool: {
        query: (...args: unknown[]) => mockQuery(...args),
        connect: (...args: unknown[]) => mockConnect(...args),
    },
}));

vi.mock('../site-membership-flag', () => ({
    siteMembershipEnabled: () => mockSiteMembershipEnabled(),
}));

import {
    authenticateOAuthAccessToken,
    cleanupExpiredOAuthRecords,
    createAuthCode,
    listUserOAuthGrantsForSite,
    registerDcrClient,
    exchangeAuthCode,
    rotateRefreshToken,
} from './oauth-repo';

describe('oauth-repo', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockSiteMembershipEnabled.mockReturnValue(true);
        mockConnect.mockResolvedValue({
            query: mockClientQuery,
            release: mockClientRelease,
        });
    });

    it('exchangeAuthCode consumes code atomically, verifies PKCE, creates grant/sites/tokens, and links grant_id', async () => {
        const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
        const challenge = createHash('sha256').update(verifier).digest('base64url');

        mockClientQuery
            .mockResolvedValueOnce({ rows: [] }) // BEGIN
            .mockResolvedValueOnce({
                rows: [{
                    client_id: 'pwu_client_1',
                    client_name: 'Claude',
                    client_uri: null,
                    user_id: 'user-1',
                    redirect_uri: 'https://claude.ai/cb',
                    code_challenge: challenge,
                    resource: 'https://pwusage.fm.rodeo/api/mcp',
                    scopes: ['billing:read', 'usage:read'],
                    site_ids: ['site-1', 'site-2'],
                    session_version: 3,
                }],
            }) // UPDATE OAuthAuthCode
            .mockResolvedValueOnce({ rows: [] }) // INSERT OAuthGrant
            .mockResolvedValueOnce({ rows: [] }) // INSERT OAuthGrantSite
            .mockResolvedValueOnce({ rows: [] }) // INSERT access OAuthToken
            .mockResolvedValueOnce({ rows: [] }) // INSERT refresh OAuthToken
            .mockResolvedValueOnce({ rows: [] }) // UPDATE OAuthAuthCode grant_id
            .mockResolvedValueOnce({ rows: [] }) // UPDATE OAuthClient last_used_at
            .mockResolvedValueOnce({ rows: [] }); // COMMIT

        const result = await exchangeAuthCode({
            code: 'raw-auth-code',
            clientId: 'pwu_client_1',
            redirectUri: 'https://claude.ai/cb',
            codeVerifier: verifier,
            resource: 'https://pwusage.fm.rodeo/api/mcp',
        });

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.accessToken.startsWith('pwu_oat_')).toBe(true);
            expect(result.refreshToken.startsWith('pwu_ort_')).toBe(true);
            expect(result.scope).toBe('billing:read usage:read');
        }
        expect(mockClientRelease).toHaveBeenCalledTimes(1);
        // The code is redeemable only while its user is active and has not signed out everywhere since it was issued.
        // The grant carries the consent's session_version, so a sign-out that races this exchange still kills it.
        const [grantSql, grantParams] = mockClientQuery.mock.calls[2];
        expect(String(grantSql)).toMatch(/INSERT INTO "OAuthGrant"[\s\S]*session_version/);
        expect(grantParams).toContain(3);
        const consumeSql = String(mockClientQuery.mock.calls[1][0]);
        expect(consumeSql).toMatch(/u\.is_active\s*=\s*true/);
        expect(consumeSql).toMatch(/u\.session_version\s*=\s*c\.session_version/);
    });

    it('createAuthCode stamps the user\'s current session_version and refuses inactive users', async () => {
        mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });
        await createAuthCode({
            clientId: 'pwu_client_1', clientName: 'Claude', clientUri: null, userId: 'user-1',
            redirectUri: 'https://claude.ai/cb', codeChallenge: 'c'.repeat(43),
            resource: 'https://pwusage.fm.rodeo/api/mcp', scopes: ['billing:read'], siteIds: ['site-1'],
        });
        const sql = String(mockQuery.mock.calls[0][0]);
        expect(sql).toMatch(/session_version/);
        expect(sql).toMatch(/FROM "User" u/);
        expect(sql).toMatch(/u\.is_active\s*=\s*true/);

        mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });
        await expect(createAuthCode({
            clientId: 'pwu_client_1', clientName: 'Claude', clientUri: null, userId: 'gone',
            redirectUri: 'https://claude.ai/cb', codeChallenge: 'c'.repeat(43),
            resource: 'https://pwusage.fm.rodeo/api/mcp', scopes: ['billing:read'], siteIds: ['site-1'],
        })).rejects.toThrow(/inactive/i);
    });

    it('exchangeAuthCode revokes grant when a consumed code is replayed', async () => {
        mockClientQuery
            .mockResolvedValueOnce({ rows: [] }) // BEGIN
            .mockResolvedValueOnce({ rows: [] }) // UPDATE OAuthAuthCode (0 rows)
            .mockResolvedValueOnce({
                rows: [{ consumed_at: new Date(), grant_id: 'grant-99' }],
            }) // SELECT OAuthAuthCode
            .mockResolvedValueOnce({ rows: [] }) // UPDATE OAuthGrant revoked_at
            .mockResolvedValueOnce({ rows: [] }) // UPDATE OAuthToken revoked_at
            .mockResolvedValueOnce({ rows: [] }); // COMMIT

        const result = await exchangeAuthCode({
            code: 'replayed-code',
            clientId: 'pwu_client_1',
            redirectUri: 'https://claude.ai/cb',
            codeVerifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
            resource: 'https://pwusage.fm.rodeo/api/mcp',
        });

        expect(result).toEqual({
            ok: false,
            error: 'invalid_grant',
            errorDescription: 'Authorization code is invalid or expired',
        });
        expect(mockClientQuery).toHaveBeenCalledWith(
            expect.stringContaining('UPDATE "OAuthGrant"'),
            ['grant-99'],
        );
    });

    it('rotateRefreshToken rotates tokens and caps refresh expiry at grant max_expires_at', async () => {
        const maxExpiresAt = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
        mockClientQuery
            .mockResolvedValueOnce({ rows: [] }) // BEGIN
            .mockResolvedValueOnce({ rows: [{ grant_id: 'grant-1' }] }) // UPDATE OAuthToken used_at
            .mockResolvedValueOnce({
                rows: [{
                    id: 'grant-1',
                    user_id: 'user-1',
                    client_id: 'pwu_client_1',
                    resource: 'https://pwusage.fm.rodeo/api/mcp',
                    scopes: ['billing:read'],
                    max_expires_at: maxExpiresAt,
                    revoked_at: null,
                    session_version: 2,
                }],
            }) // SELECT OAuthGrant
            .mockResolvedValueOnce({ rows: [{ is_active: true, session_version: 2 }] }) // SELECT User
            .mockResolvedValueOnce({ rows: [] }) // INSERT access token
            .mockResolvedValueOnce({ rows: [] }) // INSERT refresh token
            .mockResolvedValueOnce({ rows: [] }) // UPDATE OAuthGrant last_used_at
            .mockResolvedValueOnce({ rows: [] }); // COMMIT

        const result = await rotateRefreshToken({
            refreshToken: 'pwu_ort_valid_token',
            clientId: 'pwu_client_1',
            resource: 'https://pwusage.fm.rodeo/api/mcp',
        });

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.accessToken.startsWith('pwu_oat_')).toBe(true);
            expect(result.refreshToken.startsWith('pwu_ort_')).toBe(true);
        }
    });

    it('rotateRefreshToken refuses a grant from before the user signed out everywhere', async () => {
        mockClientQuery
            .mockResolvedValueOnce({ rows: [] }) // BEGIN
            .mockResolvedValueOnce({ rows: [{ grant_id: 'grant-1' }] }) // UPDATE OAuthToken used_at
            .mockResolvedValueOnce({
                rows: [{
                    id: 'grant-1', user_id: 'user-1', client_id: 'pwu_client_1',
                    resource: 'https://pwusage.fm.rodeo/api/mcp', scopes: ['billing:read'],
                    max_expires_at: new Date(Date.now() + 86_400_000), revoked_at: null, session_version: 0,
                }],
            }) // SELECT OAuthGrant
            .mockResolvedValueOnce({ rows: [{ is_active: true, session_version: 1 }] }) // SELECT User
            .mockResolvedValueOnce({ rows: [] }); // ROLLBACK

        const result = await rotateRefreshToken({
            refreshToken: 'pwu_ort_valid_token',
            clientId: 'pwu_client_1',
            resource: 'https://pwusage.fm.rodeo/api/mcp',
        });
        expect(result).toMatchObject({ ok: false, error: 'invalid_grant' });
        expect(mockClientQuery.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO "OAuthToken"'))).toBe(false);
    });

    it('rotateRefreshToken revokes entire grant on refresh token reuse', async () => {
        mockClientQuery
            .mockResolvedValueOnce({ rows: [] }) // BEGIN
            .mockResolvedValueOnce({ rows: [] }) // UPDATE OAuthToken used_at (0 rows)
            .mockResolvedValueOnce({
                rows: [{ grant_id: 'grant-compromised', used_at: new Date() }],
            }) // SELECT OAuthToken
            .mockResolvedValueOnce({ rows: [] }) // UPDATE OAuthGrant revoked_at
            .mockResolvedValueOnce({ rows: [] }) // UPDATE OAuthToken revoked_at
            .mockResolvedValueOnce({ rows: [] }); // COMMIT

        const result = await rotateRefreshToken({
            refreshToken: 'pwu_ort_reused_token',
            clientId: 'pwu_client_1',
            resource: 'https://pwusage.fm.rodeo/api/mcp',
        });

        expect(result.ok).toBe(false);
        expect(mockClientQuery).toHaveBeenCalledWith(
            expect.stringContaining('UPDATE "OAuthGrant"'),
            ['grant-compromised'],
        );
    });

    it('authenticateOAuthAccessToken rejects non-pwu_oat_ tokens and intersects live SiteMember', async () => {
        expect(await authenticateOAuthAccessToken('Bearer pwu_int_wrong', 'https://pwusage.fm.rodeo/api/mcp')).toBeNull();
        expect(mockQuery).not.toHaveBeenCalled();

        mockQuery
            .mockResolvedValueOnce({
                rows: [{
                    grant_id: 'grant-1',
                    user_id: 'user-1',
                    client_id: 'pwu_client_1',
                    client_name: 'Claude',
                    scopes: ['billing:read', 'usage:read'],
                }],
            })
            .mockResolvedValueOnce({
                rows: [{ site_id: 'site-1' }],
            })
            .mockResolvedValueOnce({ rows: [] });

        const ctx = await authenticateOAuthAccessToken('Bearer pwu_oat_valid', 'https://pwusage.fm.rodeo/api/mcp');
        expect(ctx).toEqual({
            grantId: 'grant-1',
            userId: 'user-1',
            clientId: 'pwu_client_1',
            clientName: 'Claude',
            scopes: ['billing:read', 'usage:read'],
            authorizedSiteIds: ['site-1'],
        });
    });

    it('cleanupExpiredOAuthRecords runs all 4 cleanup deletes and returns counts', async () => {
        mockQuery
            .mockResolvedValueOnce({ rowCount: 2 })
            .mockResolvedValueOnce({ rowCount: 3 })
            .mockResolvedValueOnce({ rowCount: 4 })
            .mockResolvedValueOnce({ rowCount: 1 });

        const counts = await cleanupExpiredOAuthRecords();
        expect(counts).toEqual({
            deletedClients: 2,
            deletedAuthCodes: 3,
            deletedTokens: 4,
            deletedGrants: 1,
        });
        expect(mockQuery).toHaveBeenCalledTimes(4);
    });

    it('registerDcrClient caps registrations that were never used', async () => {
        mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });
        const ok = await registerDcrClient({ clientName: 'A', redirectUris: ['https://a.example/cb'], clientUri: null });
        expect(ok?.clientId.startsWith('pwu_client_')).toBe(true);
        const sql = String(mockQuery.mock.calls[0][0]);
        expect(sql).toMatch(/last_used_at IS NULL/);
        expect(sql).toMatch(/count\(\*\)/i);

        mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });
        expect(await registerDcrClient({ clientName: 'B', redirectUris: ['https://a.example/cb'], clientUri: null })).toBeNull();
    });

    it('listUserOAuthGrantsForSite says where each app came from (CIMD host, or null when self-registered)', async () => {
        const row = (client_id: string) => ({
            id: 'g', client_id, client_name: 'Claude', client_uri: null, scopes: ['billing:read'],
            created_at: new Date('2026-11-25T00:00:00Z'), last_used_at: null, max_expires_at: new Date('2027-02-23T00:00:00Z'), site_count: '1',
        });
        mockQuery.mockResolvedValueOnce({ rows: [row('https://claude.ai/oauth/client.json'), row('pwu_client_1')] });
        const grants = await listUserOAuthGrantsForSite('user-1', 'site-1');
        expect(grants.map(g => g.publisherHost)).toEqual(['claude.ai', null]);
    });

    it('access tokens and the Settings list ignore grants from before a sign out everywhere', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [] });
        await authenticateOAuthAccessToken('Bearer pwu_oat_x', 'https://pwusage.fm.rodeo/api/mcp');
        expect(String(mockQuery.mock.calls[0][0])).toMatch(/g\.session_version\s*=\s*u\.session_version/);

        mockQuery.mockReset();
        mockQuery.mockResolvedValueOnce({ rows: [] });
        await listUserOAuthGrantsForSite('user-1', 'site-1');
        expect(String(mockQuery.mock.calls[0][0])).toMatch(/g\.session_version\s*=\s*u\.session_version/);
    });
});
