import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    verifySiteAccess: vi.fn(),
    getCurrentUser: vi.fn(),
    getAuthorizedSiteIds: vi.fn(),
    isUserAdmin: vi.fn(),
    getSite: vi.fn(),
    exchangeCodeForToken: vi.fn(),
    fetchMe: vi.fn(),
    getInstallationByUuid: vi.fn(),
    createInstallation: vi.fn(),
    withRequestContext: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock('@/lib/auth-checks', () => ({
    verifySiteAccess: mocks.verifySiteAccess,
    getCurrentUser: mocks.getCurrentUser,
    getAuthorizedSiteIds: mocks.getAuthorizedSiteIds,
    isUserAdmin: mocks.isUserAdmin,
}));

vi.mock('@/lib/site-repo', () => ({
    SiteRepo: class {
        getSite = mocks.getSite;
    }
}));

vi.mock('@/lib/trmnl-service', () => ({
    TrmnlService: class {
        exchangeCodeForToken = mocks.exchangeCodeForToken;
        fetchMe = mocks.fetchMe;
        getInstallationByUuid = mocks.getInstallationByUuid;
        createInstallation = mocks.createInstallation;
    }
}));

vi.mock('@/lib/request-context', () => ({
    withRequestContext: mocks.withRequestContext
}));

import { POST } from './route';

describe('POST /api/trmnl/setup', () => {
    const origEnv = process.env;

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getCurrentUser.mockResolvedValue({ id: 'installer-1' });
        mocks.isUserAdmin.mockResolvedValue(false);
        mocks.getAuthorizedSiteIds.mockResolvedValue(['site-1']);
        mocks.getInstallationByUuid.mockResolvedValue(null);
        mocks.createInstallation.mockResolvedValue(1);
        process.env = {
            ...origEnv,
            TRMNL_CLIENT_ID: 'client-id-123',
            TRMNL_CLIENT_SECRET: 'client-secret-456'
        };
    });

    afterEach(() => {
        process.env = origEnv;
    });

    it('returns 500 when TRMNL client credentials are missing in env', async () => {
        delete process.env.TRMNL_CLIENT_ID;

        const req = new Request('http://localhost/api/trmnl/setup', {
            method: 'POST',
            body: JSON.stringify({ code: 'oauth-code', site_id: 'site-1' })
        });
        const res = await POST(req);
        expect(res.status).toBe(500);
        const data = await res.json();
        expect(data.error).toContain('Missing Trmnl credentials');
    });

    it('returns 403 when site_id is unauthorized before token exchange', async () => {
        mocks.verifySiteAccess.mockResolvedValue(false);

        const req = new Request('http://localhost/api/trmnl/setup', {
            method: 'POST',
            body: JSON.stringify({ code: 'oauth-code', site_id: 'unauthorized-site' })
        });
        const res = await POST(req);
        expect(res.status).toBe(403);
        expect(mocks.exchangeCodeForToken).not.toHaveBeenCalled();
    });

    it('returns 404 when site does not exist', async () => {
        mocks.verifySiteAccess.mockResolvedValue(true);
        mocks.getSite.mockResolvedValue(null);

        const req = new Request('http://localhost/api/trmnl/setup', {
            method: 'POST',
            body: JSON.stringify({ code: 'oauth-code', site_id: 'nonexistent-site' })
        });
        const res = await POST(req);
        expect(res.status).toBe(404);
        expect(mocks.exchangeCodeForToken).not.toHaveBeenCalled();
    });

    it('rejects setup when body UUID hint does not match provider UUID (device A code cannot change device B)', async () => {
        mocks.verifySiteAccess.mockResolvedValue(true);
        mocks.getSite.mockResolvedValue({ id: 'site-1' });
        mocks.exchangeCodeForToken.mockResolvedValue({
            access_token: 'device-a-token',
            user_uuid: 'device-a-uuid'
        });

        const req = new Request('http://localhost/api/trmnl/setup', {
            method: 'POST',
            body: JSON.stringify({
                code: 'oauth-code-device-a',
                site_id: 'site-1',
                uuid: 'device-b-uuid'
            })
        });
        const res = await POST(req);
        expect(res.status).toBe(403);
        expect(mocks.createInstallation).not.toHaveBeenCalled();
    });

    it('rejects reassignment of an existing device owned by another site and enforces ownership at the write', async () => {
        mocks.verifySiteAccess.mockImplementation(async (siteId: string) => siteId === 'site-attacker');
        mocks.getAuthorizedSiteIds.mockResolvedValue(['site-attacker']);
        mocks.getSite.mockResolvedValue({ id: 'site-attacker' });
        mocks.exchangeCodeForToken.mockResolvedValue({
            access_token: 'attacker-token',
            user_uuid: 'device-b-uuid'
        });
        mocks.getInstallationByUuid.mockResolvedValue({
            id: 42,
            uuid: 'device-b-uuid',
            site_id: 'site-victim',
            access_token: 'victim-token'
        });

        const req = new Request('http://localhost/api/trmnl/setup', {
            method: 'POST',
            body: JSON.stringify({
                code: 'oauth-code',
                site_id: 'site-attacker',
                uuid: 'device-b-uuid'
            })
        });
        const res = await POST(req);
        expect(res.status).toBe(403);
        expect(mocks.createInstallation).not.toHaveBeenCalled();
    });

    it('returns 403 when concurrent write ownership guard rejects overwrite', async () => {
        mocks.verifySiteAccess.mockResolvedValue(true);
        mocks.getAuthorizedSiteIds.mockResolvedValue(['site-1']);
        mocks.getSite.mockResolvedValue({ id: 'site-1' });
        mocks.exchangeCodeForToken.mockResolvedValue({
            access_token: 'access-token-1',
            user_uuid: 'device-b-uuid'
        });
        mocks.getInstallationByUuid.mockResolvedValue(null);
        mocks.createInstallation.mockResolvedValue(null);

        const req = new Request('http://localhost/api/trmnl/setup', {
            method: 'POST',
            body: JSON.stringify({
                code: 'oauth-code',
                site_id: 'site-1',
                uuid: 'device-b-uuid'
            })
        });
        const res = await POST(req);
        expect(res.status).toBe(403);
    });

    it('allows legitimate setup when body UUID hint matches provider UUID and relinking across owned sites', async () => {
        mocks.verifySiteAccess.mockResolvedValue(true);
        mocks.getAuthorizedSiteIds.mockResolvedValue(['site-1', 'site-2']);
        mocks.getSite.mockResolvedValue({ id: 'site-2' });
        mocks.exchangeCodeForToken.mockResolvedValue({
            access_token: 'access-token-2',
            user_uuid: 'uuid-from-token'
        });
        mocks.getInstallationByUuid.mockResolvedValue({
            id: 10,
            uuid: 'uuid-from-token',
            site_id: 'site-1'
        });

        const req = new Request('http://localhost/api/trmnl/setup', {
            method: 'POST',
            body: JSON.stringify({
                code: 'oauth-code',
                site_id: 'site-2',
                uuid: 'uuid-from-token'
            })
        });
        const res = await POST(req);
        expect(res.status).toBe(200);
        expect(mocks.createInstallation).toHaveBeenCalledWith(
            'site-2',
            'uuid-from-token',
            null,
            expect.any(Object),
            'access-token-2',
            'installer-1',
            { allowedExistingSiteIds: ['site-1', 'site-2'] }
        );
    });

    it('extracts UUID from JWT payload when missing in token response', async () => {
        mocks.verifySiteAccess.mockResolvedValue(true);
        mocks.getSite.mockResolvedValue({ id: 'site-1' });

        // Build valid JWT header.payload.signature
        const payloadJson = JSON.stringify({ user_uuid: 'uuid-from-jwt' });
        const base64Payload = Buffer.from(payloadJson).toString('base64url');
        const mockJwt = `eyJhbGciOiJIUzI1NiJ9.${base64Payload}.signature`;

        mocks.exchangeCodeForToken.mockResolvedValue({ access_token: mockJwt });

        const req = new Request('http://localhost/api/trmnl/setup', {
            method: 'POST',
            body: JSON.stringify({ code: 'oauth-code', site_id: 'site-1' })
        });
        const res = await POST(req);
        expect(res.status).toBe(200);
        expect(mocks.createInstallation).toHaveBeenCalledWith(
            'site-1',
            'uuid-from-jwt',
            null,
            expect.any(Object),
            mockJwt,
            'installer-1',
            { allowedExistingSiteIds: ['site-1'] }
        );
    });

    it('creates pending_webhook installation when UUID discovery fails but provider returns plugin_setting_id', async () => {
        mocks.verifySiteAccess.mockResolvedValue(true);
        mocks.getSite.mockResolvedValue({ id: 'site-1' });
        mocks.exchangeCodeForToken.mockResolvedValue({
            access_token: 'opaque-access-token',
            plugin_setting_id: 42
        });
        mocks.fetchMe.mockRejectedValue(new Error('API Error'));

        const req = new Request('http://localhost/api/trmnl/setup', {
            method: 'POST',
            body: JSON.stringify({
                code: 'oauth-code',
                site_id: 'site-1',
                plugin_setting_id: '42'
            })
        });
        const res = await POST(req);
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.status).toBe('pending_webhook');
        expect(mocks.createInstallation).toHaveBeenCalledWith(
            'site-1',
            null,
            42,
            expect.any(Object),
            'opaque-access-token',
            'installer-1'
        );
    });

    it('ignores unverified browser plugin_setting_id hint when UUID discovery fails (creates pending_loose)', async () => {
        mocks.verifySiteAccess.mockResolvedValue(true);
        mocks.getSite.mockResolvedValue({ id: 'site-1' });
        mocks.exchangeCodeForToken.mockResolvedValue({ access_token: 'opaque-access-token' });
        mocks.fetchMe.mockRejectedValue(new Error('API Error'));

        const req = new Request('http://localhost/api/trmnl/setup', {
            method: 'POST',
            body: JSON.stringify({
                code: 'oauth-code',
                site_id: 'site-1',
                plugin_setting_id: '999'
            })
        });
        const res = await POST(req);
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.status).toBe('pending_loose');
        expect(mocks.createInstallation).toHaveBeenCalledWith(
            'site-1',
            null,
            null,
            expect.any(Object),
            'opaque-access-token',
            'installer-1'
        );
    });

    it('creates pending_loose installation when UUID discovery fails and no plugin_setting_id exists', async () => {
        mocks.verifySiteAccess.mockResolvedValue(true);
        mocks.getSite.mockResolvedValue({ id: 'site-1' });
        mocks.exchangeCodeForToken.mockResolvedValue({ access_token: 'opaque-access-token' });
        mocks.fetchMe.mockRejectedValue(new Error('API Error'));

        const req = new Request('http://localhost/api/trmnl/setup', {
            method: 'POST',
            body: JSON.stringify({
                code: 'oauth-code',
                site_id: 'site-1'
            })
        });
        const res = await POST(req);
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.status).toBe('pending_loose');
        expect(mocks.createInstallation).toHaveBeenCalledWith(
            'site-1',
            null,
            null,
            expect.any(Object),
            'opaque-access-token',
            'installer-1'
        );
    });

    it('does not produce NaN or accept partially numeric strings for plugin_setting_id', async () => {
        mocks.verifySiteAccess.mockResolvedValue(true);
        mocks.getSite.mockResolvedValue({ id: 'site-1' });
        mocks.exchangeCodeForToken.mockResolvedValue({ access_token: 'opaque-access-token' });
        mocks.fetchMe.mockRejectedValue(new Error('API Error'));

        for (const badId of ['invalid-non-numeric', '42abc', 'abc42']) {
            vi.clearAllMocks();
            const req = new Request('http://localhost/api/trmnl/setup', {
                method: 'POST',
                body: JSON.stringify({
                    code: 'oauth-code',
                    site_id: 'site-1',
                    plugin_setting_id: badId
                })
            });
            const res = await POST(req);
            expect(res.status).toBe(200);
            const data = await res.json();
            expect(data.status).toBe('pending_loose');
            expect(mocks.createInstallation).toHaveBeenCalledWith(
                'site-1',
                null,
                null,
                expect.any(Object),
                'opaque-access-token',
                'installer-1'
            );
        }
    });
});
