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

import { GET } from './route';

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let result = '';
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        result += decoder.decode(value);
    }
    return result;
}

describe('GET /api/sync', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('rejects missing parameters with 400', async () => {
        const req = new Request('http://localhost/api/sync?siteId=site-1');
        const res = await GET(req);
        expect(res.status).toBe(400);
    });

    it('rejects invalid date parameters with 400', async () => {
        mocks.getAuthorizedSiteIds.mockResolvedValue(['site-1']);
        mocks.createTeslaClientForSite.mockResolvedValue({ siteId: 'site-1' });
        const req = new Request('http://localhost/api/sync?siteId=site-1&start=invalid-date&end=2026-05-01');
        const res = await GET(req);
        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data.error).toContain('Invalid date');
    });

    it('rejects unauthorized site access with 403', async () => {
        mocks.getAuthorizedSiteIds.mockResolvedValue(['other-site']);
        const req = new Request('http://localhost/api/sync?siteId=site-1&start=2026-05-01&end=2026-05-02');
        const res = await GET(req);
        expect(res.status).toBe(403);
    });

    it('returns 401 when Tesla client cannot be created', async () => {
        mocks.getAuthorizedSiteIds.mockResolvedValue(['site-1']);
        mocks.createTeslaClientForSite.mockResolvedValue(null);

        const req = new Request('http://localhost/api/sync?siteId=site-1&start=2026-05-01&end=2026-05-02');
        const res = await GET(req);
        expect(res.status).toBe(401);
    });

    it('emits checking, progress, and complete SSE frames', async () => {
        mocks.getAuthorizedSiteIds.mockResolvedValue(['site-1']);
        mocks.createTeslaClientForSite.mockResolvedValue({ siteId: 'site-1' });
        mocks.ensureDataForRange.mockImplementation(async (siteId: string, start: Date, end: Date, onProgress: (msg: string) => void) => {
            onProgress('Syncing day 1...');
            return { complete: true, processedWindows: 1, totalWindows: 1 };
        });

        const req = new Request('http://localhost/api/sync?siteId=site-1&start=2026-05-01&end=2026-05-02');
        const res = await GET(req);
        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type')).toBe('text/event-stream');

        const streamText = await readStream(res.body!);
        expect(streamText).toContain('{"status":"checking"}');
        expect(streamText).toContain('{"status":"progress","message":"Syncing day 1..."}');
        expect(streamText).toContain('{"status":"complete"}');
    });

    it('terminates unavailable history with a compatible complete frame', async () => {
        mocks.getAuthorizedSiteIds.mockResolvedValue(['site-1']);
        mocks.createTeslaClientForSite.mockResolvedValue({ siteId: 'site-1' });
        mocks.ensureDataForRange.mockResolvedValue({ complete: true, processedWindows: 0, totalWindows: 0,
            historyAvailability: { status: 'unavailable', availableFrom: '2026-07-03T00:00:00.000Z', effectiveDays: 90 } });
        const res = await GET(new Request('http://localhost/api/sync?siteId=site-1&start=2026-05-01&end=2026-05-02'));
        const text = await readStream(res.body!);
        expect(text).toContain('"status":"complete"');
        expect(text).toContain('"historyAvailability":{"status":"unavailable"');
        expect(text).not.toContain('"status":"partial"');
        expect(mocks.ensureDataForRange).toHaveBeenCalledTimes(1);
    });

    it('emits partial SSE frame when importer hits time budget', async () => {
        mocks.getAuthorizedSiteIds.mockResolvedValue(['site-1']);
        mocks.createTeslaClientForSite.mockResolvedValue({ siteId: 'site-1' });
        mocks.ensureDataForRange.mockResolvedValue({
            complete: false,
            processedWindows: 3,
            totalWindows: 10
        });

        const req = new Request('http://localhost/api/sync?siteId=site-1&start=2026-05-01&end=2026-05-10');
        const res = await GET(req);
        const streamText = await readStream(res.body!);

        expect(streamText).toContain('"status":"partial"');
        expect(streamText).toContain('Synced 3 days, continuing...');
    });

    it('emits SSE error frame when importer throws', async () => {
        mocks.getAuthorizedSiteIds.mockResolvedValue(['site-1']);
        mocks.createTeslaClientForSite.mockResolvedValue({ siteId: 'site-1' });
        mocks.ensureDataForRange.mockRejectedValue(new Error('Tesla API rate limited'));

        const req = new Request('http://localhost/api/sync?siteId=site-1&start=2026-05-01&end=2026-05-02');
        const res = await GET(req);
        const streamText = await readStream(res.body!);

        expect(streamText).toContain('"status":"error"');
        expect(streamText).toContain('Tesla API rate limited');
    });
});
