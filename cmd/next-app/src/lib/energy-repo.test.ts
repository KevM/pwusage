import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMock } = vi.hoisted(() => ({
    queryMock: vi.fn()
}));

vi.mock('./db', () => ({
    pool: {
        query: queryMock
    }
}));

import { EnergyRepo } from './energy-repo';
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

describe('EnergyRepo site payload selection', () => {
    beforeEach(() => {
        queryMock.mockReset();
        const repo = new EnergyRepo();
        repo.invalidateCache('site-1');
    });

    it('fetches slim site columns by default', async () => {
        queryMock.mockResolvedValueOnce({ rows: [makeSiteJoinRow()] });

        const repo = new EnergyRepo();
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

        const repo = new EnergyRepo();
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

        const repo = new EnergyRepo();
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

        const repo = new EnergyRepo();
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

describe('EnergyRepo.getCycleAggregates', () => {
    const start = new Date('2026-04-01T00:00:00Z');
    const end   = new Date('2026-04-28T00:00:00Z');

    beforeEach(() => {
        queryMock.mockReset();
    });

    it('returns an empty array when there are no rows', async () => {
        queryMock.mockResolvedValueOnce({ rows: [] });

        const repo = new EnergyRepo();
        const result = await repo.getCycleAggregates('site-1', start, end);

        expect(result).toEqual([]);
        expect(queryMock).toHaveBeenCalledWith(
            expect.stringContaining('GROUP BY'),
            ['site-1', start, end]
        );
    });

    it('coerces pg numeric strings to JS numbers', async () => {
        queryMock.mockResolvedValueOnce({
            rows: [{
                day: '2026-04-15T00:00:00Z',
                tariff_id: '42',
                tariff_schedule_id: '7',
                load_power: '100000',
                solar_power: '80000',
                grid_power: '20000',
                battery_power: '-5000',
            }]
        });

        const repo = new EnergyRepo();
        const [row] = await repo.getCycleAggregates('site-1', start, end);

        expect(typeof row.tariff_id).toBe('number');
        expect(row.tariff_id).toBe(42);
        expect(typeof row.tariff_schedule_id).toBe('number');
        expect(row.tariff_schedule_id).toBe(7);
        expect(row.load_power).toBe(100000);
        expect(row.solar_power).toBe(80000);
        expect(row.grid_power).toBe(20000);
        expect(row.battery_power).toBe(-5000);
        expect(row.day).toBeInstanceOf(Date);
    });

    it('maps NULL tariff_schedule_id to null (not 0)', async () => {
        queryMock.mockResolvedValueOnce({
            rows: [{
                day: '2026-04-15T00:00:00Z',
                tariff_id: '42',
                tariff_schedule_id: null,
                load_power: '50000',
                solar_power: '0',
                grid_power: '50000',
                battery_power: '0',
            }]
        });

        const repo = new EnergyRepo();
        const [row] = await repo.getCycleAggregates('site-1', start, end);

        expect(row.tariff_schedule_id).toBeNull();
    });

    it('returns one row per distinct (day, tariff_id, tariff_schedule_id) combination', async () => {
        queryMock.mockResolvedValueOnce({
            rows: [
                {
                    day: '2026-04-14T00:00:00Z',
                    tariff_id: '1',
                    tariff_schedule_id: '10',
                    load_power: '60000',
                    solar_power: '30000',
                    grid_power: '30000',
                    battery_power: '0',
                },
                {
                    day: '2026-04-14T00:00:00Z',
                    tariff_id: '1',
                    tariff_schedule_id: '11',
                    load_power: '90000',
                    solar_power: '10000',
                    grid_power: '80000',
                    battery_power: '0',
                },
                {
                    day: '2026-04-15T00:00:00Z',
                    tariff_id: '1',
                    tariff_schedule_id: '10',
                    load_power: '70000',
                    solar_power: '40000',
                    grid_power: '30000',
                    battery_power: '0',
                },
            ]
        });

        const repo = new EnergyRepo();
        const rows = await repo.getCycleAggregates('site-1', start, end);

        expect(rows).toHaveLength(3);

        const apr14Rows = rows.filter(r => r.day.toISOString().startsWith('2026-04-14'));
        expect(apr14Rows).toHaveLength(2);
        expect(apr14Rows.map(r => r.tariff_schedule_id).sort()).toEqual([10, 11]);

        const apr15Rows = rows.filter(r => r.day.toISOString().startsWith('2026-04-15'));
        expect(apr15Rows).toHaveLength(1);
        expect(apr15Rows[0].load_power).toBe(70000);
    });

    it('queries EnergyData with GROUP BY day, tariff_id, tariff_schedule_id', async () => {
        queryMock.mockResolvedValueOnce({ rows: [] });

        const repo = new EnergyRepo();
        await repo.getCycleAggregates('site-1', start, end);

        const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
        expect(sql).toContain('GROUP BY');
        expect(sql).toContain('tariff_id');
        expect(sql).toContain('tariff_schedule_id');
        expect(sql).toContain('"EnergyData"');
        expect(params).toEqual(['site-1', start, end]);
    });
});

describe('EnergyRepo getRawEnergyData column projection', () => {
    beforeEach(() => {
        queryMock.mockReset();
    });

    it('selects explicit columns and excludes id', async () => {
        queryMock.mockResolvedValueOnce({ rows: [] });

        const repo = new EnergyRepo();
        await repo.getRawEnergyData('site-1', new Date('2026-04-01'), new Date('2026-04-02'));

        expect(queryMock).toHaveBeenCalledTimes(1);
        const sql = queryMock.mock.calls[0][0] as string;

        // Should not use SELECT *
        expect(sql).not.toMatch(/SELECT\s+\*/i);

        // Should include the 9 required columns
        expect(sql).toMatch(/site_id/);
        expect(sql).toMatch(/timestamp/);
        expect(sql).toMatch(/tariff_id/);
        expect(sql).toMatch(/tariff_schedule_id/);
        expect(sql).toMatch(/load_power/);
        expect(sql).toMatch(/solar_power/);
        expect(sql).toMatch(/grid_power/);
        expect(sql).toMatch(/battery_power/);
        expect(sql).toMatch(/battery_soc/);

        // Extract just the SELECT clause (between SELECT and FROM)
        const selectClause = sql.match(/SELECT([\s\S]+?)FROM/i)?.[1] ?? '';
        // Should NOT include the id column in the projection
        expect(selectClause).not.toMatch(/\bid\b/);
    });

    it('returns rows with battery_soc value preserved', async () => {
        queryMock.mockResolvedValueOnce({
            rows: [{
                site_id: 'site-1',
                timestamp: new Date('2026-04-01T00:00:00Z'),
                tariff_id: 1,
                tariff_schedule_id: 2,
                load_power: 1000,
                solar_power: 500,
                grid_power: 300,
                battery_power: 200,
                battery_soc: 75
            }]
        });

        const repo = new EnergyRepo();
        const rows = await repo.getRawEnergyData('site-1', new Date('2026-04-01'), new Date('2026-04-02'));

        expect(rows).toHaveLength(1);
        expect(rows[0].battery_soc).toBe(75);
        expect(rows[0].load_power).toBe(1000);
        expect(rows[0].site_id).toBe('site-1');
        expect(rows[0].tariff_id).toBe(1);
        expect(rows[0].tariff_schedule_id).toBe(2);
    });

    it('preserves null battery_soc', async () => {
        queryMock.mockResolvedValueOnce({
            rows: [{
                site_id: 'site-1',
                timestamp: new Date('2026-04-01T00:00:00Z'),
                tariff_id: 1,
                tariff_schedule_id: 2,
                load_power: 1000,
                solar_power: 500,
                grid_power: 300,
                battery_power: 200,
                battery_soc: null
            }]
        });

        const repo = new EnergyRepo();
        const rows = await repo.getRawEnergyData('site-1', new Date('2026-04-01'), new Date('2026-04-02'));

        expect(rows).toHaveLength(1);
        expect(rows[0].battery_soc).toBeNull();
    });
});

describe('EnergyRepo getSite request-scoped cache', () => {
    beforeEach(() => {
        queryMock.mockReset();
        const repo = new EnergyRepo();
        repo.invalidateCache('site-1');
    });

    it('reuses the request-cache on a second getSite call within the same request', async () => {
        await withRequestContext(async () => {
            const repo = new EnergyRepo();
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
            const repo = new EnergyRepo();
            repo.invalidateCache('site-1');
            queryMock.mockResolvedValueOnce({ rows: [makeSiteJoinRow()] });
            await repo.getSite('site-1');
        });

        // Second request: invalidate persistent cache — must re-query
        await withRequestContext(async () => {
            const repo = new EnergyRepo();
            repo.invalidateCache('site-1');
            queryMock.mockReset();
            queryMock.mockResolvedValueOnce({ rows: [makeSiteJoinRow()] });

            await repo.getSite('site-1');
            expect(queryMock.mock.calls.length).toBe(1); // hit DB, not request cache
        });
    });
});

describe('EnergyRepo.getSitesWithTariffs', () => {
    beforeEach(() => {
        queryMock.mockReset();
        const repo = new EnergyRepo();
        repo.invalidateCache('site-1');
        repo.invalidateCache('site-2');
    });

    it('returns empty array without querying when called with empty ids', async () => {
        const repo = new EnergyRepo();
        const result = await repo.getSitesWithTariffs([]);
        expect(result).toEqual([]);
        expect(queryMock).not.toHaveBeenCalled();
    });

    it('assembles a site with no tariffs (all tariff columns null)', async () => {
        queryMock.mockResolvedValueOnce({ rows: [makeSiteJoinRow()] });

        const repo = new EnergyRepo();
        const [site] = await repo.getSitesWithTariffs(['site-1']);

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

        const repo = new EnergyRepo();
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

        const repo = new EnergyRepo();
        const sites = await repo.getSitesWithTariffs(['site-1', 'site-2']);

        expect(sites).toHaveLength(2);
        expect(queryMock).toHaveBeenCalledTimes(1);
        const [, params] = queryMock.mock.calls[0] as [string, unknown[]];
        expect(params).toEqual([['site-1', 'site-2']]);
    });

    it('only fetches uncached ids when some are already in module cache', async () => {
        // Pre-populate module cache for site-1
        queryMock.mockResolvedValueOnce({ rows: [makeSiteJoinRow({ id: 'site-1' })] });
        const repo = new EnergyRepo();
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
        const repo = new EnergyRepo();
        await repo.getSitesWithTariffs(['site-1', 'site-2']);
        queryMock.mockReset();

        const sites = await repo.getSitesWithTariffs(['site-1', 'site-2']);
        expect(sites).toHaveLength(2);
        expect(queryMock).not.toHaveBeenCalled();
    });

    it('re-fetches when cached entry lacks json and includeJson is requested', async () => {
        // Warm cache without json
        queryMock.mockResolvedValueOnce({ rows: [makeSiteJoinRow()] });
        const repo = new EnergyRepo();
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
});
