import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    getSitesForGapHeal: vi.fn(),
    createTeslaClientForSite: vi.fn(),
    ensureDataForRange: vi.fn(),
    countAlignedSamples: vi.fn(),
    planMissingWindows: vi.fn(),
}));

vi.mock('./site-repo', () => ({
    SiteRepo: vi.fn(function SiteRepo() {
        return { getSitesForGapHeal: mocks.getSitesForGapHeal };
    }),
}));
vi.mock('./energy-repo', () => ({
    EnergyRepo: { countAlignedSamples: mocks.countAlignedSamples },
}));
vi.mock('./tesla-client-factory', () => ({ createTeslaClientForSite: mocks.createTeslaClientForSite }));
vi.mock('./importer', () => ({
    Importer: vi.fn(function Importer() {
        return { ensureDataForRange: mocks.ensureDataForRange };
    }),
    planMissingWindows: mocks.planMissingWindows,
}));

import { healTrailingGaps } from './gap-heal';

const NOW = new Date('2026-10-17T15:00:00Z'); // 10:00 in America/Chicago
const INSTALLED = new Date('2025-01-01T00:00:00Z');
const FULL_14_DAYS = 14 * 288;

describe('healTrailingGaps', () => {
    let clock: number;

    beforeEach(() => {
        vi.clearAllMocks();
        clock = 0;
        mocks.getSitesForGapHeal.mockResolvedValue([
            { id: 'site-a', timezone: 'America/Chicago', installed: INSTALLED },
            { id: 'site-b', timezone: 'America/Chicago', installed: INSTALLED },
        ]);
        // Default: no stored samples, so every site goes through the full heal path.
        mocks.countAlignedSamples.mockResolvedValue(new Map());
        mocks.planMissingWindows.mockResolvedValue([{ start: new Date(0), end: new Date(1) }]);
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

    it('reaches back to the start of an auth outage that ended within the window', async () => {
        mocks.getSitesForGapHeal.mockResolvedValue([{
            id: 'site-a', timezone: 'America/Chicago', installed: INSTALLED,
            auth_lost_at: new Date('2026-09-20T18:00:00Z'), auth_restored_at: new Date('2026-10-15T12:00:00Z'),
        }]);

        await run();

        const [, start] = mocks.ensureDataForRange.mock.calls[0];
        expect(start.toISOString()).toBe('2026-09-20T05:00:00.000Z'); // Chicago midnight of the loss day
        const [[counted]] = mocks.countAlignedSamples.mock.calls[0];
        expect(counted.start.toISOString()).toBe('2026-09-20T05:00:00.000Z');
        expect(mocks.planMissingWindows.mock.calls[0][0]).toMatchObject({ auth_restored_at: new Date('2026-10-15T12:00:00Z') });
    });

    it('keeps the 14-day window for an older restore or a current outage', async () => {
        mocks.getSitesForGapHeal.mockResolvedValue([
            { id: 'old-restore', timezone: 'America/Chicago', installed: INSTALLED,
                auth_lost_at: new Date('2026-08-01T00:00:00Z'), auth_restored_at: new Date('2026-10-01T00:00:00Z') },
            { id: 'still-lost', timezone: 'America/Chicago', installed: INSTALLED,
                auth_lost_at: new Date('2026-10-10T00:00:00Z'), auth_restored_at: new Date('2026-09-01T00:00:00Z') },
        ]);

        await run();

        expect(mocks.ensureDataForRange.mock.calls.map(c => c[1].toISOString()))
            .toEqual(['2026-10-03T05:00:00.000Z', '2026-10-03T05:00:00.000Z']);
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
            { id: 'site-a', timezone: 'America/Chicago', installed: INSTALLED },
            { id: 'site-b', timezone: 'America/Chicago', installed: INSTALLED },
            { id: 'site-c', timezone: 'America/Chicago', installed: INSTALLED },
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
        mocks.getSitesForGapHeal.mockResolvedValue([{ id: 'site-a', timezone: 'America/Chicago', installed: INSTALLED }]);
        mocks.ensureDataForRange.mockResolvedValue({ complete: false, rows: [], processedWindows: 0, totalWindows: 0 });

        const result = await run();

        expect(result.sites).toEqual([{ siteId: 'site-a', status: 'busy' }]);
    });
    it('checks every site with one count query and skips sites whose window is fully stored', async () => {
        mocks.countAlignedSamples.mockResolvedValue(new Map([['site-a', FULL_14_DAYS], ['site-b', FULL_14_DAYS - 1]]));

        const result = await run();

        expect(mocks.countAlignedSamples).toHaveBeenCalledTimes(1);
        expect(mocks.countAlignedSamples).toHaveBeenCalledWith([
            { siteId: 'site-a', start: new Date('2026-10-03T05:00:00Z'), end: new Date('2026-10-17T05:00:00Z') },
            { siteId: 'site-b', start: new Date('2026-10-03T05:00:00Z'), end: new Date('2026-10-17T05:00:00Z') },
        ]);
        // The complete site never loads tokens, the site row, the lock or coverage.
        expect(mocks.createTeslaClientForSite).toHaveBeenCalledTimes(1);
        expect(mocks.createTeslaClientForSite).toHaveBeenCalledWith('site-b');
        expect(result.checked).toBe(2);
        expect(result.sites.map(s => s.siteId)).toEqual(['site-b']);
    });

    it('expects the real number of slots across a DST change', async () => {
        // Oct 22 05:00Z (CDT midnight) to Nov 5 06:00Z (CST midnight): 14 days + 1 hour.
        mocks.countAlignedSamples.mockResolvedValue(new Map([['site-a', 4044], ['site-b', 4043]]));

        const result = await run({ now: () => new Date('2026-11-05T15:00:00Z') });

        expect(result.sites.map(s => s.siteId)).toEqual(['site-b']);
    });

    it('starts the expected window at the installation day for new sites', async () => {
        mocks.getSitesForGapHeal.mockResolvedValue([
            { id: 'site-a', timezone: 'America/Chicago', installed: new Date('2026-10-10T17:00:00Z') },
        ]);
        mocks.countAlignedSamples.mockResolvedValue(new Map([['site-a', 7 * 288]]));

        const result = await run();

        expect(mocks.countAlignedSamples.mock.calls[0][0][0].start).toEqual(new Date('2026-10-10T05:00:00Z'));
        expect(result.sites).toEqual([]);
    });
    it('skips tokens, the site load and the lock when short sites have nothing planImport would fetch', async () => {
        // Sub-threshold gaps (under 30 min) leave the count short but plan no windows.
        mocks.planMissingWindows.mockResolvedValueOnce([]);

        const result = await run();

        expect(mocks.planMissingWindows).toHaveBeenCalledWith(
            { id: 'site-a', timezone: 'America/Chicago', installed: INSTALLED },
            new Date('2026-10-03T05:00:00Z'),
            new Date('2026-10-17T05:00:00Z'));
        expect(mocks.createTeslaClientForSite).toHaveBeenCalledTimes(1);
        expect(mocks.createTeslaClientForSite).toHaveBeenCalledWith('site-b');
        expect(result.sites[0]).toEqual({ siteId: 'site-a', status: 'complete', processedWindows: 0, totalWindows: 0 });
    });
});
