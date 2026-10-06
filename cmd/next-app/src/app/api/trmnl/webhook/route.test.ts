import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    verifyTrmnlToken: vi.fn(),
    safeTimingSafeEqual: vi.fn((a: string | null | undefined, b: string | null | undefined) => a === b),
    getInstallationByUuid: vi.fn(),
    getInstallationByPendingPluginId: vi.fn(),
    getLatestLoosePendingInstallation: vi.fn(),
    createInstallation: vi.fn(),
    claimPendingInstallationById: vi.fn(),
    getSite: vi.fn(),
    getUserEmail: vi.fn(),
    updateUserEmail: vi.fn(),
}));

vi.mock('@/lib/trmnl-auth', () => ({
    verifyTrmnlToken: (token: string, expectedUuid: string) => mocks.verifyTrmnlToken(token, expectedUuid),
    safeTimingSafeEqual: (a: string | null | undefined, b: string | null | undefined) => mocks.safeTimingSafeEqual(a, b),
    verifyTrmnlRequestAuth: vi.fn(),
}));

vi.mock('@/lib/trmnl-service', () => ({
    TrmnlService: class {
        getInstallationByUuid = mocks.getInstallationByUuid;
        getInstallationByPendingPluginId = mocks.getInstallationByPendingPluginId;
        getLatestLoosePendingInstallation = mocks.getLatestLoosePendingInstallation;
        createInstallation = mocks.createInstallation;
        claimPendingInstallationById = mocks.claimPendingInstallationById;
    }
}));

vi.mock('@/lib/site-repo', () => ({
    SiteRepo: class {
        getSite = mocks.getSite;
    }
}));

vi.mock('@/lib/user-repo', () => ({
    UserRepo: class {
        getUserEmail = mocks.getUserEmail;
        updateUserEmail = mocks.updateUserEmail;
    }
}));

import { POST } from './route';

describe('POST /api/trmnl/webhook', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.safeTimingSafeEqual.mockImplementation((a: string | null | undefined, b: string | null | undefined) => a === b);
        mocks.verifyTrmnlToken.mockImplementation(async (_token: string, uuid: string) => ({
            sub: uuid,
            plugin_setting_id: 10
        }));
    });

    it('returns 400 if user or uuid is missing in body', async () => {
        const req = new Request('http://localhost/api/trmnl/webhook', {
            method: 'POST',
            body: JSON.stringify({ user: {} })
        });
        const res = await POST(req);
        expect(res.status).toBe(400);
    });

    it('rejects unsigned webhook', async () => {
        const req = new Request('http://localhost/api/trmnl/webhook', {
            method: 'POST',
            body: JSON.stringify({ user: { uuid: 'dev-1', plugin_setting_id: 10 } })
        });
        const res = await POST(req);
        expect(res.status).toBe(401);
        const data = await res.json();
        expect(data.error).toContain('Missing token');
    });

    it('rejects JWT with wrong sub or invalid token', async () => {
        mocks.verifyTrmnlToken.mockImplementationOnce(async () => {
            throw new Error('Invalid signature');
        });
        const req = new Request('http://localhost/api/trmnl/webhook', {
            method: 'POST',
            headers: { Authorization: 'Bearer invalid.jwt.token' },
            body: JSON.stringify({ user: { uuid: 'dev-1', plugin_setting_id: 10 } })
        });
        const res = await POST(req);
        expect(res.status).toBe(401);
        const data = await res.json();
        expect(data.error).toContain('Invalid token');
    });

    it('rejects opaque token unless it matches stored access_token', async () => {
        mocks.getInstallationByUuid.mockResolvedValue(null);
        mocks.getInstallationByPendingPluginId.mockResolvedValue(null);
        mocks.getLatestLoosePendingInstallation.mockResolvedValue(null);

        const req = new Request('http://localhost/api/trmnl/webhook', {
            method: 'POST',
            headers: { Authorization: 'Bearer opaque-secret' },
            body: JSON.stringify({ user: { uuid: 'dev-1', plugin_setting_id: 10 } })
        });
        const res = await POST(req);
        expect(res.status).toBe(401);
        const data = await res.json();
        expect(data.error).toContain('Invalid opaque token');
    });

    it('rejects plugin setting mismatch between token and body', async () => {
        mocks.verifyTrmnlToken.mockImplementationOnce(async (_token: string, uuid: string) => ({
            sub: uuid,
            plugin_setting_id: 20
        }));

        const req = new Request('http://localhost/api/trmnl/webhook', {
            method: 'POST',
            headers: { Authorization: 'Bearer jwt.header.payload' },
            body: JSON.stringify({ user: { uuid: 'dev-1', plugin_setting_id: 10 } })
        });
        const res = await POST(req);
        expect(res.status).toBe(403);
        const data = await res.json();
        expect(data.error).toContain('Plugin ID mismatch');
    });

    it('claims pending install by plugin_setting_id', async () => {
        mocks.verifyTrmnlToken.mockResolvedValue({
            sub: 'dev-1',
            plugin_setting_id: 10
        });
        mocks.getInstallationByUuid.mockResolvedValue(null);
        mocks.getInstallationByPendingPluginId.mockResolvedValue({
            id: 'pending-100',
            site_id: 'site-a',
            created_at: new Date().toISOString(),
            json: {}
        });

        const req = new Request('http://localhost/api/trmnl/webhook', {
            method: 'POST',
            headers: { Authorization: 'Bearer jwt.token.val' },
            body: JSON.stringify({ user: { uuid: 'dev-1', plugin_setting_id: 10 } })
        });
        const res = await POST(req);
        expect(res.status).toBe(200);
        expect(mocks.claimPendingInstallationById).toHaveBeenCalledWith(
            'pending-100',
            'dev-1',
            10,
            expect.any(Object)
        );
    });

    it('claims loose pending install only when younger than 15 minutes', async () => {
        mocks.verifyTrmnlToken.mockResolvedValue({
            sub: 'dev-1',
            plugin_setting_id: 10
        });
        mocks.getInstallationByUuid.mockResolvedValue(null);
        mocks.getInstallationByPendingPluginId.mockResolvedValue(null);
        mocks.getLatestLoosePendingInstallation.mockResolvedValue({
            id: 'loose-1',
            site_id: 'site-b',
            created_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
            json: {}
        });

        const req = new Request('http://localhost/api/trmnl/webhook', {
            method: 'POST',
            headers: { Authorization: 'Bearer jwt.token.val' },
            body: JSON.stringify({ user: { uuid: 'dev-1', plugin_setting_id: 10 } })
        });
        const res = await POST(req);
        expect(res.status).toBe(200);
        expect(mocks.claimPendingInstallationById).toHaveBeenCalledWith(
            'loose-1',
            'dev-1',
            10,
            expect.any(Object)
        );
    });

    it('does not claim stale loose pending install older than 15 minutes', async () => {
        mocks.verifyTrmnlToken.mockResolvedValue({
            sub: 'dev-1',
            plugin_setting_id: 10
        });
        mocks.getInstallationByUuid.mockResolvedValue(null);
        mocks.getInstallationByPendingPluginId.mockResolvedValue(null);
        mocks.getLatestLoosePendingInstallation.mockResolvedValue({
            id: 'stale-1',
            site_id: 'site-b',
            created_at: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
            json: {}
        });

        const req = new Request('http://localhost/api/trmnl/webhook', {
            method: 'POST',
            headers: { Authorization: 'Bearer jwt.token.val' },
            body: JSON.stringify({ user: { uuid: 'dev-1', plugin_setting_id: 10 } })
        });
        const res = await POST(req);
        expect(res.status).toBe(200);
        expect(mocks.claimPendingInstallationById).not.toHaveBeenCalled();
    });

    it('preserves existing component screen config when updating existing installation', async () => {
        mocks.verifyTrmnlToken.mockResolvedValue({
            sub: 'dev-1',
            plugin_setting_id: 10
        });

        const existingJson = {
            component_screens: [
                { id: 'screen-1', name: 'Solar', component_config: { showLiveSolar: true } },
                { id: 'screen-2', name: 'Battery', component_config: { showLiveBattery: true } }
            ],
            carousel_index: 1
        };

        mocks.getInstallationByUuid.mockResolvedValue({
            id: 'inst-1',
            uuid: 'dev-1',
            site_id: 'site-a',
            json: existingJson
        });

        const req = new Request('http://localhost/api/trmnl/webhook', {
            method: 'POST',
            headers: { Authorization: 'Bearer jwt.token.val' },
            body: JSON.stringify({
                user: { uuid: 'dev-1', plugin_setting_id: 10, email: 'user@example.com' }
            })
        });

        mocks.getSite.mockResolvedValue({ id: 'site-a', user_id: 'user-1' });
        mocks.getUserEmail.mockResolvedValue('user@example.com'); // email already set

        const res = await POST(req);
        expect(res.status).toBe(200);
        expect(mocks.createInstallation).toHaveBeenCalledWith(
            'site-a',
            'dev-1',
            10,
            expect.objectContaining({
                carousel_index: 1,
                component_screens: expect.arrayContaining([
                    expect.objectContaining({ id: 'screen-1', name: 'Solar' }),
                    expect.objectContaining({ id: 'screen-2', name: 'Battery' })
                ])
            })
        );
        expect(mocks.updateUserEmail).not.toHaveBeenCalled();
    });

    it('syncs email only when site has user_id and user email is absent', async () => {
        mocks.verifyTrmnlToken.mockResolvedValue({
            sub: 'dev-1',
            plugin_setting_id: 10
        });

        mocks.getInstallationByUuid.mockResolvedValue({
            id: 'inst-1',
            uuid: 'dev-1',
            site_id: 'site-a',
            json: {}
        });

        mocks.getSite.mockResolvedValue({ id: 'site-a', user_id: 'user-99' });
        mocks.getUserEmail.mockResolvedValue(null);

        const req = new Request('http://localhost/api/trmnl/webhook', {
            method: 'POST',
            headers: { Authorization: 'Bearer jwt.token.val' },
            body: JSON.stringify({
                user: { uuid: 'dev-1', plugin_setting_id: 10, email: 'new@example.com' }
            })
        });

        const res = await POST(req);
        expect(res.status).toBe(200);
        expect(mocks.updateUserEmail).toHaveBeenCalledWith('user-99', 'new@example.com');
    });

    it('rejects partially numeric plugin_setting_id in body (e.g. "10abc")', async () => {
        mocks.verifyTrmnlToken.mockResolvedValue({
            sub: 'dev-1',
            plugin_setting_id: 10
        });

        const req = new Request('http://localhost/api/trmnl/webhook', {
            method: 'POST',
            headers: { Authorization: 'Bearer jwt.header.payload' },
            body: JSON.stringify({ user: { uuid: 'dev-1', plugin_setting_id: '10abc' } })
        });
        const res = await POST(req);
        expect(res.status).toBe(403);
        const data = await res.json();
        expect(data.error).toContain('Plugin ID mismatch');
    });
});
