import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    getAuthorizedSiteIds: vi.fn(),
    createTeslaClientForSite: vi.fn(),
    ensureDataForRange: vi.fn(),
    importerClients: [] as unknown[],
}));

vi.mock('@/lib/auth-checks', () => ({
    getAuthorizedSiteIds: mocks.getAuthorizedSiteIds
}));

vi.mock('@/lib/tesla-client-factory', () => ({
    createTeslaClientForSite: mocks.createTeslaClientForSite
}));

vi.mock('@/lib/importer', () => ({
    Importer: class {
        constructor(private client: unknown) {
            mocks.importerClients.push(client);
        }
        ensureDataForRange = (siteId: string, start: Date, end: Date) =>
            mocks.ensureDataForRange(this.client, siteId, start, end);
    }
}));

import { POST } from './route';

describe('POST /api/import', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.importerClients = [];
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

    it('isolates Tesla clients and archives across multiple authorized sites with distinct Tesla IDs', async () => {
        mocks.getAuthorizedSiteIds.mockResolvedValue(['site-1', 'site-2']);

        const providerReadings = new Map<string, number>([
            ['tesla-101', 12.5],
            ['tesla-202', 48.75],
        ]);
        const providerReads: string[] = [];
        const archives = new Map<string, number>();

        const makeClient = (teslaSiteId: string) => ({
            teslaSiteId,
            readReading: () => {
                providerReads.push(teslaSiteId);
                return providerReadings.get(teslaSiteId)!;
            }
        });

        mocks.createTeslaClientForSite.mockImplementation(async (siteId: string) => {
            if (siteId === 'site-1') return makeClient('tesla-101');
            if (siteId === 'site-2') return makeClient('tesla-202');
            return null;
        });

        mocks.ensureDataForRange.mockImplementation(async (client: ReturnType<typeof makeClient>, siteId: string) => {
            const reading = client.readReading();
            archives.set(siteId, reading);
        });

        const req = new Request('http://localhost/api/import', { method: 'POST' });
        const res = await POST(req);
        expect(res.status).toBe(200);

        const data = await res.json();
        expect(data.success).toBe(true);
        expect(data.successCount).toBe(2);
        expect(data.errors).toBeUndefined();

        expect(mocks.createTeslaClientForSite).toHaveBeenCalledTimes(2);
        expect(mocks.createTeslaClientForSite).toHaveBeenNthCalledWith(1, 'site-1', expect.any(Object));
        expect(mocks.createTeslaClientForSite).toHaveBeenNthCalledWith(2, 'site-2', expect.any(Object));
        expect(providerReads).toEqual(['tesla-101', 'tesla-202']);
        expect(archives.get('site-1')).toBe(12.5);
        expect(archives.get('site-2')).toBe(48.75);
    });

    it('imports a second site when the first site lacks credentials', async () => {
        mocks.getAuthorizedSiteIds.mockResolvedValue(['site-no-creds', 'site-ok']);
        const archives = new Map<string, number>();

        mocks.createTeslaClientForSite.mockImplementation(async (siteId: string) => {
            if (siteId === 'site-no-creds') return null;
            return { teslaSiteId: 'tesla-ok', readReading: () => 33.1 };
        });

        mocks.ensureDataForRange.mockImplementation(async (client: { readReading: () => number }, siteId: string) => {
            archives.set(siteId, client.readReading());
        });

        const req = new Request('http://localhost/api/import', { method: 'POST' });
        const res = await POST(req);
        expect(res.status).toBe(200);

        const data = await res.json();
        expect(data.success).toBe(true);
        expect(data.successCount).toBe(1);
        expect(data.errors).toEqual({
            'site-no-creds': 'Unauthorized or no credentials found'
        });
        expect(archives.get('site-ok')).toBe(33.1);
        expect(archives.has('site-no-creds')).toBe(false);
    });
});
