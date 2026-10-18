import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    getSitesForGapHeal: vi.fn(),
    createTeslaClientForSite: vi.fn(),
    ensureDataForRange: vi.fn(),
}));

vi.mock('./site-repo', () => ({
    SiteRepo: vi.fn(function SiteRepo() {
        return { getSitesForGapHeal: mocks.getSitesForGapHeal };
    }),
}));
vi.mock('./tesla-client-factory', () => ({ createTeslaClientForSite: mocks.createTeslaClientForSite }));
vi.mock('./importer', () => ({
    Importer: vi.fn(function Importer() {
        return { ensureDataForRange: mocks.ensureDataForRange };
    }),
}));

import { healTrailingGaps } from './gap-heal';

const NOW = new Date('2026-10-17T15:00:00Z'); // 10:00 in America/Chicago

describe('healTrailingGaps', () => {
    let clock: number;

    beforeEach(() => {
        vi.clearAllMocks();
        clock = 0;
        mocks.getSitesForGapHeal.mockResolvedValue([
            { id: 'site-a', timezone: 'America/Chicago' },
            { id: 'site-b', timezone: 'America/Chicago' },
        ]);
        mocks.createTeslaClientForSite.mockResolvedValue({});
        mocks.ensureDataForRange.mockResolvedValue({ complete: true, rows: [], processedWindows: 0, totalWindows: 0 });
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    const run = (overrides = {}) => healTrailingGaps({
        now: () => NOW,
        clock: () => clock,
        days: 14,
        maxWindowsPerSite: 3,
        maxTimeMs: 35_000,
        ...overrides,
    });

    it('audits the trailing complete site-local days, excluding today, with the window cap', async () => {
        const result = await run();

        expect(mocks.ensureDataForRange).toHaveBeenCalledTimes(2);
        const [siteId, start, end, , options] = mocks.ensureDataForRange.mock.calls[0];
        expect(siteId).toBe('site-a');
        expect(end.toISOString()).toBe('2026-10-17T05:00:00.000Z'); // today's Chicago midnight
        expect(start.toISOString()).toBe('2026-10-03T05:00:00.000Z'); // 14 days earlier
        expect(options).toEqual({ maxTimeMs: 35_000, maxWindows: 3 });
        expect(result.sites.map(s => s.status)).toEqual(['complete', 'complete']);
        expect(result.stopped).toBeUndefined();
    });

    it('only heals sites with live activity (web, mobile, TRMNL, battery hold) in the last 7 days', async () => {
        await run();

        expect(mocks.getSitesForGapHeal).toHaveBeenCalledWith(NOW.getTime() - 7 * 24 * 60 * 60 * 1000);
    });

    it('reports partial when windows remain, and passes only the remaining time budget on', async () => {
        mocks.ensureDataForRange.mockImplementationOnce(async () => {
            clock += 20_000;
            return { complete: false, rows: [], processedWindows: 3, totalWindows: 5 };
        });

        const result = await run();

        expect(mocks.ensureDataForRange.mock.calls[1][4]).toEqual({ maxTimeMs: 15_000, maxWindows: 3 });
        expect(result.sites[0]).toMatchObject({ siteId: 'site-a', status: 'partial', processedWindows: 3, totalWindows: 5 });
    });

    it('stops before the next site once the time budget is spent', async () => {
        mocks.ensureDataForRange.mockImplementationOnce(async () => {
            clock += 35_000;
            return { complete: false, rows: [], processedWindows: 1, totalWindows: 4 };
        });

        const result = await run();

        expect(mocks.ensureDataForRange).toHaveBeenCalledTimes(1);
        expect(result.stopped).toBe('time-budget');
        expect(result.sites.map(s => s.siteId)).toEqual(['site-a']);
    });

    it('skips sites without tokens and isolates per-site failures', async () => {
        mocks.createTeslaClientForSite.mockResolvedValueOnce(null);
        mocks.getSitesForGapHeal.mockResolvedValue([
            { id: 'site-a', timezone: 'America/Chicago' },
            { id: 'site-b', timezone: 'America/Chicago' },
            { id: 'site-c', timezone: 'America/Chicago' },
        ]);
        mocks.ensureDataForRange
            .mockRejectedValueOnce(new Error('tesla down'))
            .mockResolvedValueOnce({ complete: true, rows: [], processedWindows: 1, totalWindows: 1 });

        const result = await run();

        expect(result.sites).toEqual([
            { siteId: 'site-a', status: 'no-tokens' },
            { siteId: 'site-b', status: 'error', errorMessage: 'tesla down' },
            { siteId: 'site-c', status: 'complete', processedWindows: 1, totalWindows: 1 },
        ]);
    });

    it('reports a site whose import lock was busy as skipped', async () => {
        mocks.getSitesForGapHeal.mockResolvedValue([{ id: 'site-a', timezone: 'America/Chicago' }]);
        mocks.ensureDataForRange.mockResolvedValue({ complete: false, rows: [], processedWindows: 0, totalWindows: 0 });

        const result = await run();

        expect(result.sites).toEqual([{ siteId: 'site-a', status: 'busy' }]);
    });
});
