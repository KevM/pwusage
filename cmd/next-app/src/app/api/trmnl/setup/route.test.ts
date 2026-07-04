import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    verifySiteAccess: vi.fn(),
    getSite: vi.fn(),
    exchangeCodeForToken: vi.fn(),
    fetchMe: vi.fn(),
    createInstallation: vi.fn(),
    withRequestContext: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock('@/lib/auth-checks', () => ({
    verifySiteAccess: mocks.verifySiteAccess
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

    it('prioritizes UUID from body over token response, JWT payload, and fetchMe', async () => {
        mocks.verifySiteAccess.mockResolvedValue(true);
        mocks.getSite.mockResolvedValue({ id: 'site-1' });
        mocks.exchangeCodeForToken.mockResolvedValue({
            access_token: 'access-token-1',
            user_uuid: 'uuid-from-token'
        });

        const req = new Request('http://localhost/api/trmnl/setup', {
            method: 'POST',
            body: JSON.stringify({
                code: 'oauth-code',
                site_id: 'site-1',
                uuid: 'uuid-from-body'
            })
        });
        const res = await POST(req);
        expect(res.status).toBe(200);
        expect(mocks.createInstallation).toHaveBeenCalledWith(
            'site-1',
            'uuid-from-body',
            null,
            expect.any(Object),
            'access-token-1'
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
            mockJwt
        );
    });

    it('creates pending_webhook installation when UUID discovery fails but plugin_setting_id exists', async () => {
        mocks.verifySiteAccess.mockResolvedValue(true);
        mocks.getSite.mockResolvedValue({ id: 'site-1' });
        mocks.exchangeCodeForToken.mockResolvedValue({ access_token: 'opaque-access-token' });
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
            'opaque-access-token'
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
            'opaque-access-token'
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
                'opaque-access-token'
            );
        }
    });
});
