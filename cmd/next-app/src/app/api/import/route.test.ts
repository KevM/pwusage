import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    getAuthorizedSiteIds: vi.fn(),
    createTeslaClientForSite: vi.fn(),
    ensureDataForRange: vi.fn(),
}));

vi.mock('@/lib/auth-checks', () => ({
    getAuthorizedSiteIds: mocks.getAuthorizedSiteIds
}));

vi.mock('@/lib/tesla-client-factory', () => ({
    createTeslaClientForSite: mocks.createTeslaClientForSite
}));

vi.mock('@/lib/importer', () => ({
    Importer: class {
        ensureDataForRange = mocks.ensureDataForRange;
    }
}));

import { POST } from './route';

describe('POST /api/import', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns 403 when user has no authorized sites', async () => {
        mocks.getAuthorizedSiteIds.mockResolvedValue([]);

        const req = new Request('http://localhost/api/import', { method: 'POST' });
        const res = await POST(req);
        expect(res.status).toBe(403);
        const data = await res.json();
        expect(data.error).toBe('No sites authorized');
    });

    it('returns 401 when Tesla client cannot be created', async () => {
        mocks.getAuthorizedSiteIds.mockResolvedValue(['site-1']);
        mocks.createTeslaClientForSite.mockResolvedValue(null);

        const req = new Request('http://localhost/api/import', { method: 'POST' });
        const res = await POST(req);
        expect(res.status).toBe(401);
        const data = await res.json();
        expect(data.error).toContain('Unauthorized or no credentials found');
    });

    it('reports partial success (status 200) with errors when some sites succeed and some fail', async () => {
        mocks.getAuthorizedSiteIds.mockResolvedValue(['site-1', 'site-2']);
        mocks.createTeslaClientForSite.mockResolvedValue({ client: 'ok' });
        mocks.ensureDataForRange
            .mockResolvedValueOnce(undefined) // site-1 success
            .mockRejectedValueOnce(new Error('Site 2 API offline')); // site-2 failure

        const req = new Request('http://localhost/api/import', { method: 'POST' });
        const res = await POST(req);
        expect(res.status).toBe(200);

        const data = await res.json();
        expect(data.success).toBe(true);
        expect(data.successCount).toBe(1);
        expect(data.errors).toEqual({ 'site-2': 'Site 2 API offline' });
    });

    it('returns 502 Bad Gateway only when every authorized site fails', async () => {
        mocks.getAuthorizedSiteIds.mockResolvedValue(['site-1', 'site-2']);
        mocks.createTeslaClientForSite.mockResolvedValue({ client: 'ok' });
        mocks.ensureDataForRange.mockRejectedValue(new Error('Tesla network error'));

        const req = new Request('http://localhost/api/import', { method: 'POST' });
        const res = await POST(req);
        expect(res.status).toBe(502);

        const data = await res.json();
        expect(data.success).toBe(false);
        expect(data.successCount).toBe(0);
        expect(data.errors).toEqual({
            'site-1': 'Tesla network error',
            'site-2': 'Tesla network error'
        });
    });
});
