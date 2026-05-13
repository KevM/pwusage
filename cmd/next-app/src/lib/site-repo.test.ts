import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMock } = vi.hoisted(() => ({
    queryMock: vi.fn()
}));

vi.mock('./db', () => ({
    pool: {
        query: queryMock
    }
}));

import { SiteRepo } from './site-repo';
import { withRequestContext } from './request-context';

function makeSiteJoinRow(overrides: Record<string, unknown> = {}) {
    return {
        id: 'site-1',
        user_id: 'user-1',
        name: 'Home',
        utility: null,
        updated: new Date('2026-01-01T00:00:00Z'),
        installed: new Date('2025-01-01T00:00:00Z'),
        timezone: 'America/Chicago',
        billing_start_day: 1,
        timezone_display_mode: null,
        access_token: 'a',
        refresh_token: 'r',
        auth_status: 'active',
        tariff_id: null,
        tariff_name: null,
        tariff_updated: null,
        tariff_site_id: null,
        season_id: null,
        season_name: null,
        from_month: null, from_day: null,
        to_month: null, to_day: null,
        season_buy_rate: null, season_sell_rate: null,
        schedule_id: null,
        schedule_name: null,
        schedule_buy_rate: null, schedule_sell_rate: null,
        from_day_of_week: null, from_hour: null, from_minute: null,
        to_day_of_week: null, to_hour: null, to_minute: null,
        ...overrides,
    };
}

describe('SiteRepo site payload selection', () => {
    beforeEach(() => {
        queryMock.mockReset();
        const repo = new SiteRepo();
        repo.invalidateCache('site-1');
    });

    it('fetches slim site columns by default', async () => {
        queryMock.mockResolvedValueOnce({ rows: [makeSiteJoinRow()] });

        const repo = new SiteRepo();
        await repo.getSite('site-1');

        expect(queryMock).toHaveBeenCalledTimes(1);
        const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
        expect(sql).toContain('ANY($1');
        expect(sql).not.toContain('s.json');
        expect(params).toEqual([['site-1']]);
    });

    it('includes site json only when explicitly requested', async () => {
        queryMock.mockResolvedValueOnce({
            rows: [makeSiteJoinRow({ json: { components: { battery: true } } })]
        });

        const repo = new SiteRepo();
        const site = await repo.getSite('site-1', { includeJson: true });

        expect(queryMock).toHaveBeenCalledTimes(1);
        const [sql] = queryMock.mock.calls[0] as [string, unknown[]];
        expect(sql).toContain('s.json');
        expect(site?.json).toEqual({ components: { battery: true } });
    });

    it('fetches slim site rows for user lists', async () => {
        queryMock.mockResolvedValueOnce({
            rows: [{
                id: 'site-1',
                user_id: 'user-1',
                name: 'Home',
                updated: new Date(),
                installed: new Date(),
                timezone: 'America/Chicago',
                billing_start_day: 1
            }]
        });

        const repo = new SiteRepo();
        await repo.getSitesForUser('user-1');

        expect(queryMock).toHaveBeenCalledWith(
            expect.stringContaining('SELECT id, user_id, name, utility, updated, installed, timezone, billing_start_day'),
            ['user-1']
        );
        expect(queryMock).not.toHaveBeenCalledWith(
            expect.stringContaining('SELECT * FROM "Site" WHERE user_id = $1'),
            expect.anything()
        );
    });

    it('does not fetch site json for TRMNL installation lookups', async () => {
        // Query 1: installation JOIN (getInstallationAndSite's own query)
        queryMock.mockResolvedValueOnce({
            rows: [{
                id: 1,
                uuid: 'uuid-1',
                site_id: 'site-1',
                plugin_setting_id: 123,
                created_at: new Date(),
                json: { device: true },
                access_token: 'install-token',
                refresh_token: 'install-refresh',
                tesla_access_token: 'tesla-token',
                tesla_refresh_token: 'tesla-refresh',
                tesla_auth_status: 'active'
            }]
        });
        // Query 2: getSite() JOIN (1 query, no s.json)
        queryMock.mockResolvedValueOnce({ rows: [makeSiteJoinRow()] });

        const repo = new SiteRepo();
        const result = await repo.getInstallationAndSite('uuid-1');

        expect(queryMock).toHaveBeenNthCalledWith(
            1,
            expect.not.stringContaining('s.json'),
            ['uuid-1']
        );
        // Second call is the getSite JOIN — also no s.json
        expect(queryMock).toHaveBeenCalledTimes(2);
        expect(result?.site.json).toBeUndefined();
    });
});

describe('SiteRepo getSite request-scoped cache', () => {
    beforeEach(() => {
        queryMock.mockReset();
        const repo = new SiteRepo();
        repo.invalidateCache('site-1');
    });

    it('reuses the request-cache on a second getSite call within the same request', async () => {
        await withRequestContext(async () => {
            const repo = new SiteRepo();
            repo.invalidateCache('site-1');
            queryMock.mockResolvedValueOnce({ rows: [makeSiteJoinRow()] });

            const first = await repo.getSite('site-1');
            const callCountAfterFirst = queryMock.mock.calls.length;
            expect(first?.id).toBe('site-1');
            expect(callCountAfterFirst).toBe(1);

            // Invalidate persistent cache to prove request cache is what saves us
            repo.invalidateCache('site-1');

            const second = await repo.getSite('site-1');
            expect(second?.id).toBe('site-1');
            expect(queryMock.mock.calls.length).toBe(callCountAfterFirst); // no new queries
        });
    });

    it('isolates request caches across separate requests', async () => {
        // First request populates both caches
        await withRequestContext(async () => {
            const repo = new SiteRepo();
            repo.invalidateCache('site-1');
            queryMock.mockResolvedValueOnce({ rows: [makeSiteJoinRow()] });
            await repo.getSite('site-1');
        });

        // Second request: invalidate persistent cache — must re-query
        await withRequestContext(async () => {
            const repo = new SiteRepo();
            repo.invalidateCache('site-1');
            queryMock.mockReset();
            queryMock.mockResolvedValueOnce({ rows: [makeSiteJoinRow()] });

            await repo.getSite('site-1');
            expect(queryMock.mock.calls.length).toBe(1); // hit DB, not request cache
        });
    });
});

describe('SiteRepo.getSitesWithTariffs', () => {
    beforeEach(() => {
        queryMock.mockReset();
        const repo = new SiteRepo();
        repo.invalidateCache('site-1');
        repo.invalidateCache('site-2');
    });

    it('returns empty array without querying when called with empty ids', async () => {
        const repo = new SiteRepo();
        const result = await repo.getSitesWithTariffs([]);
        expect(result).toEqual([]);
        expect(queryMock).not.toHaveBeenCalled();
    });

    it('assembles a site with no tariffs (all tariff columns null)', async () => {
        queryMock.mockResolvedValueOnce({ rows: [makeSiteJoinRow()] });

        const repo = new SiteRepo();
        const [site] = await repo.getSitesWithTariffs(['site-1'], { includeTokens: true });

        expect(site.id).toBe('site-1');
        expect(site.tariffs).toEqual([]);
        expect(site.name).toBe('Home');
        expect(site.timezone).toBe('America/Chicago');
        expect(site.access_token).toBe('a');
        expect(site.auth_status).toBe('active');
        expect(queryMock).toHaveBeenCalledTimes(1);
    });

    it('assembles a site with one tariff, one season, two schedules', async () => {
        const base = makeSiteJoinRow({
            tariff_id: 1,
            tariff_name: 'E-TOU-C',
            tariff_updated: new Date('2026-01-01'),
            tariff_site_id: 'site-1',
            season_id: 10,
            season_name: 'Summer',
            from_month: 6, from_day: 1,
            to_month: 9, to_day: 30,
            season_buy_rate: 0.40, season_sell_rate: 0.10,
        });
        queryMock.mockResolvedValueOnce({
            rows: [
                { ...base, schedule_id: 100, schedule_name: 'Peak',     schedule_buy_rate: 0.45, schedule_sell_rate: 0.08,
                  from_day_of_week: 0, from_hour: 16, from_minute: 0, to_day_of_week: 6, to_hour: 21, to_minute: 0 },
                { ...base, schedule_id: 101, schedule_name: 'Off-Peak', schedule_buy_rate: 0.25, schedule_sell_rate: 0.10,
                  from_day_of_week: 0, from_hour: 21, from_minute: 0, to_day_of_week: 6, to_hour: 16, to_minute: 0 },
            ]
        });

        const repo = new SiteRepo();
        const [site] = await repo.getSitesWithTariffs(['site-1']);

        expect(site.tariffs).toHaveLength(1);
        expect(site.tariffs[0].name).toBe('E-TOU-C');
        expect(site.tariffs[0].seasons).toHaveLength(1);
        expect(site.tariffs[0].seasons![0].schedules).toHaveLength(2);
        expect(site.tariffs[0].seasons![0].schedules![0].name).toBe('Peak');
        expect(site.tariffs[0].seasons![0].schedules![1].name).toBe('Off-Peak');
        expect(site.tariffs[0].seasons![0].schedules![0].buy_rate).toBe(0.45);
        expect(site.tariffs[0].seasons![0].schedules![0].from_hour).toBe(16);
        expect(queryMock).toHaveBeenCalledTimes(1);
    });

    it('fetches two sites in one query', async () => {
        queryMock.mockResolvedValueOnce({
            rows: [
                makeSiteJoinRow({ id: 'site-1', name: 'Home'  }),
                makeSiteJoinRow({ id: 'site-2', name: 'Cabin', user_id: 'user-2' }),
            ]
        });

        const repo = new SiteRepo();
        const sites = await repo.getSitesWithTariffs(['site-1', 'site-2']);

        expect(sites).toHaveLength(2);
        expect(queryMock).toHaveBeenCalledTimes(1);
        const [, params] = queryMock.mock.calls[0] as [string, unknown[]];
        expect(params).toEqual([['site-1', 'site-2']]);
    });

    it('only fetches uncached ids when some are already in module cache', async () => {
        // Pre-populate module cache for site-1
        queryMock.mockResolvedValueOnce({ rows: [makeSiteJoinRow({ id: 'site-1' })] });
        const repo = new SiteRepo();
        await repo.getSitesWithTariffs(['site-1']);
        queryMock.mockReset();

        // Now request site-1 (cached) and site-2 (cold)
        queryMock.mockResolvedValueOnce({ rows: [makeSiteJoinRow({ id: 'site-2', name: 'Cabin' })] });
        const sites = await repo.getSitesWithTariffs(['site-1', 'site-2']);

        expect(sites).toHaveLength(2);
        expect(queryMock).toHaveBeenCalledTimes(1);
        const [, params] = queryMock.mock.calls[0] as [string, unknown[]];
        expect(params).toEqual([['site-2']]); // only the cold id
    });

    it('returns all from cache without querying when all ids are warm', async () => {
        // Warm both sites
        queryMock.mockResolvedValueOnce({
            rows: [
                makeSiteJoinRow({ id: 'site-1' }),
                makeSiteJoinRow({ id: 'site-2', name: 'Cabin' }),
            ]
        });
        const repo = new SiteRepo();
        await repo.getSitesWithTariffs(['site-1', 'site-2']);
        queryMock.mockReset();

        const sites = await repo.getSitesWithTariffs(['site-1', 'site-2']);
        expect(sites).toHaveLength(2);
        expect(queryMock).not.toHaveBeenCalled();
    });

    it('re-fetches when cached entry lacks json and includeJson is requested', async () => {
        // Warm cache without json
        queryMock.mockResolvedValueOnce({ rows: [makeSiteJoinRow()] });
        const repo = new SiteRepo();
        await repo.getSitesWithTariffs(['site-1']);
        queryMock.mockReset();

        // Request with includeJson — must hit DB because cached entry has no json
        queryMock.mockResolvedValueOnce({
            rows: [makeSiteJoinRow({ json: { components: { battery: true } } })]
        });
        const [site] = await repo.getSitesWithTariffs(['site-1'], { includeJson: true });

        expect(queryMock).toHaveBeenCalledTimes(1);
        expect(site.json).toEqual({ components: { battery: true } });
    });

    it('re-fetches when cached entry lacks tokens and includeTokens is requested', async () => {
        // Warm cache without tokens
        queryMock.mockResolvedValueOnce({ rows: [makeSiteJoinRow()] });
        const repo = new SiteRepo();
        await repo.getSitesWithTariffs(['site-1']);
        queryMock.mockReset();

        // Request with includeTokens — must hit DB because cached entry has no tokens (undefined)
        queryMock.mockResolvedValueOnce({ rows: [makeSiteJoinRow()] });
        const [site] = await repo.getSitesWithTariffs(['site-1'], { includeTokens: true });

        expect(queryMock).toHaveBeenCalledTimes(1);
        expect(site.access_token).toBe('a');
    });
});
