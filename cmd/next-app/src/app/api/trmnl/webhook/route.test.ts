import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    verifyTrmnlToken: vi.fn(),
    safeTimingSafeEqual: vi.fn((a: string | null | undefined, b: string | null | undefined) => a === b),
    getInstallationById: vi.fn(),
    getInstallationByUuid: vi.fn(),
    getInstallationByPendingPluginId: vi.fn(),
    getLatestLoosePendingInstallation: vi.fn(),
    getRecentLoosePendingInstallations: vi.fn(),
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
        getInstallationById = mocks.getInstallationById;
        getInstallationByUuid = mocks.getInstallationByUuid;
        getInstallationByPendingPluginId = mocks.getInstallationByPendingPluginId;
        getLatestLoosePendingInstallation = mocks.getLatestLoosePendingInstallation;
        getRecentLoosePendingInstallations = mocks.getRecentLoosePendingInstallations;
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
        mocks.getRecentLoosePendingInstallations.mockResolvedValue([]);
        mocks.claimPendingInstallationById.mockResolvedValue(true);
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

    it('claims exact loose pending install for matching opaque token across overlapping installations', async () => {
        mocks.getInstallationByUuid.mockResolvedValue(null);
        mocks.getInstallationByPendingPluginId.mockResolvedValue(null);
        mocks.getRecentLoosePendingInstallations.mockResolvedValue([
            {
                id: 202,
                uuid: null,
                site_id: 'site-b',
                access_token: 'opaque-token-b',
                created_at: new Date(Date.now() - 1 * 60 * 1000).toISOString(),
                json: {}
            },
            {
                id: 101,
                uuid: null,
                site_id: 'site-a',
                access_token: 'opaque-token-a',
                created_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
                json: {}
            }
        ]);

        const req = new Request('http://localhost/api/trmnl/webhook', {
            method: 'POST',
            headers: { Authorization: 'Bearer opaque-token-a' },
            body: JSON.stringify({ user: { uuid: 'dev-a', plugin_setting_id: 10 } })
        });
        const res = await POST(req);
        expect(res.status).toBe(200);
        expect(mocks.claimPendingInstallationById).toHaveBeenCalledWith(
            101,
            'dev-a',
            10,
            expect.any(Object)
        );
    });

    it('leaves loose pending install untouched when signed JWT webhook has no plugin_setting_id correlation', async () => {
        mocks.verifyTrmnlToken.mockResolvedValue({
            sub: 'dev-b',
            plugin_setting_id: 99
        });
        mocks.getInstallationByUuid.mockResolvedValue(null);
        mocks.getInstallationByPendingPluginId.mockResolvedValue(null);
        mocks.getRecentLoosePendingInstallations.mockResolvedValue([
            {
                id: 101,
                uuid: null,
                site_id: 'site-a',
                access_token: 'opaque-token-a',
                created_at: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
                json: {}
            }
        ]);

        const req = new Request('http://localhost/api/trmnl/webhook', {
            method: 'POST',
            headers: { Authorization: 'Bearer jwt.token.val' },
            body: JSON.stringify({ user: { uuid: 'dev-b', plugin_setting_id: 99 } })
        });
        const res = await POST(req);
        expect(res.status).toBe(200);
        expect(mocks.claimPendingInstallationById).not.toHaveBeenCalled();
    });

    it('does not claim stale loose pending install older than 15 minutes even with matching opaque token', async () => {
        mocks.getInstallationByUuid.mockResolvedValue(null);
        mocks.getInstallationByPendingPluginId.mockResolvedValue(null);
        mocks.getRecentLoosePendingInstallations.mockResolvedValue([
            {
                id: 'stale-1',
                uuid: null,
                site_id: 'site-b',
                access_token: 'opaque-secret',
                created_at: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
                json: {}
            }
        ]);

        const req = new Request('http://localhost/api/trmnl/webhook', {
            method: 'POST',
            headers: { Authorization: 'Bearer opaque-secret' },
            body: JSON.stringify({ user: { uuid: 'dev-1', plugin_setting_id: 10 } })
        });
        const res = await POST(req);
        expect(res.status).toBe(401);
        expect(mocks.claimPendingInstallationById).not.toHaveBeenCalled();
    });

    it('returns 409 Conflict when a competing claim already claimed the pending row', async () => {
        mocks.verifyTrmnlToken.mockResolvedValue({
            sub: 'dev-2',
            plugin_setting_id: 10
        });
        mocks.getInstallationByUuid.mockResolvedValue(null);
        mocks.getInstallationByPendingPluginId.mockResolvedValue({
            id: 500,
            uuid: null,
            site_id: 'site-a',
            installed_by_user_id: 'user-a',
            created_at: new Date().toISOString(),
            json: {}
        });
        mocks.claimPendingInstallationById.mockResolvedValue(false);
        mocks.getInstallationById.mockResolvedValue({
            id: 500,
            uuid: 'dev-1',
            plugin_setting_id: 10,
            site_id: 'site-a'
        });

        const req = new Request('http://localhost/api/trmnl/webhook', {
            method: 'POST',
            headers: { Authorization: 'Bearer jwt.token.val' },
            body: JSON.stringify({ user: { uuid: 'dev-2', plugin_setting_id: 10, email: 'attacker@example.com' } })
        });
        const res = await POST(req);
        expect(res.status).toBe(409);
        expect(mocks.updateUserEmail).not.toHaveBeenCalled();
    });

    it('handles a legitimate retry idempotently when the same device already won the claim', async () => {
        mocks.verifyTrmnlToken.mockResolvedValue({
            sub: 'dev-1',
            plugin_setting_id: 10
        });
        mocks.getInstallationByUuid.mockResolvedValue(null);
        mocks.getInstallationByPendingPluginId.mockResolvedValue({
            id: 500,
            uuid: null,
            site_id: 'site-a',
            created_at: new Date().toISOString(),
            json: {}
        });
        mocks.claimPendingInstallationById.mockResolvedValue(false);
        mocks.getInstallationById.mockResolvedValue({
            id: 500,
            uuid: 'dev-1',
            plugin_setting_id: 10,
            site_id: 'site-a'
        });

        const req = new Request('http://localhost/api/trmnl/webhook', {
            method: 'POST',
            headers: { Authorization: 'Bearer jwt.token.val' },
            body: JSON.stringify({ user: { uuid: 'dev-1', plugin_setting_id: 10 } })
        });
        const res = await POST(req);
        expect(res.status).toBe(200);
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

    it('syncs email only to the installation creator when their email is absent', async () => {
        mocks.verifyTrmnlToken.mockResolvedValue({
            sub: 'dev-1',
            plugin_setting_id: 10
        });

        mocks.getInstallationByUuid.mockResolvedValue({
            id: 'inst-1',
            uuid: 'dev-1',
            site_id: 'site-a',
            installed_by_user_id: 'installer-99',
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
        expect(mocks.updateUserEmail).toHaveBeenCalledWith('installer-99', 'new@example.com');
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
