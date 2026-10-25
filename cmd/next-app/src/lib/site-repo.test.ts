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
import { latestStoredSampleSql } from './latest-stored-sample-sql';
import { withRequestContext } from './request-context';

function makeSiteRow(overrides: Record<string, unknown> = {}) {
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
        ...overrides,
    };
}

function makeTariffJoinRow(overrides: Record<string, unknown> = {}) {
    return {
        tariff_id: 1,
        tariff_name: 'E-TOU-C',
        tariff_updated: new Date('2026-01-01'),
        tariff_site_id: 'site-1',
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

// loadSitesFromDB now issues two queries per DB load (site scalars, then the
// tariff tree) so the wide site columns aren't repeated per join row.
function mockSiteLoad(siteRows: unknown[], tariffRows: unknown[] = []) {
    queryMock.mockResolvedValueOnce({ rows: siteRows });
    queryMock.mockResolvedValueOnce({ rows: tariffRows });
}

describe('SiteRepo site payload selection', () => {
    beforeEach(() => {
        queryMock.mockReset();
        const repo = new SiteRepo();
        repo.invalidateCache('site-1');
    });

    it('reads one small cache row without rate plans for foreground power', async () => {
        queryMock.mockResolvedValue({ rows: [{ id: 'site-1', last_live_refresh_at: 123, live_status_cache: null }] });
        const result = await new SiteRepo().getLiveRefreshState('site-1');
        expect(result?.id).toBe('site-1');
        expect(queryMock).toHaveBeenCalledTimes(1);
        const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
        expect(sql).toContain('SELECT id, last_live_refresh_at, live_status_cache');
        expect(sql).not.toContain('Tariff');
        expect(sql).not.toContain('token');
        expect(sql).not.toContain('json');
        expect(params).toEqual(['site-1']);
    });

    it('fetches slim site columns by default', async () => {
        mockSiteLoad([makeSiteRow()]);

        const repo = new SiteRepo();
        await repo.getSite('site-1');

        expect(queryMock).toHaveBeenCalledTimes(2);
        const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
        expect(sql).toContain('ANY($1');
        expect(sql).not.toContain('s.json');
        expect(params).toEqual([['site-1']]);
    });

    it('does not repeat wide site columns on tariff join rows', async () => {
        mockSiteLoad([makeSiteRow()]);

        const repo = new SiteRepo();
        await repo.getSite('site-1', { includeJson: true, includeTokens: true });

        const [siteSql] = queryMock.mock.calls[0] as [string, unknown[]];
        const [tariffSql] = queryMock.mock.calls[1] as [string, unknown[]];
        // Wide values live only in the single-row site query…
        expect(siteSql).toContain('s.json');
        expect(siteSql).toContain('live_status_cache');
        expect(siteSql).toContain('refresh_token');
        expect(siteSql).not.toContain('"Tariff"');
        // …and the tariff tree query carries none of them.
        expect(tariffSql).not.toContain('json');
        expect(tariffSql).not.toContain('live_status_cache');
        expect(tariffSql).not.toContain('token');
    });

    it('includes site json only when explicitly requested', async () => {
        mockSiteLoad([makeSiteRow({ json: { components: { battery: true } } })]);

        const repo = new SiteRepo();
        const site = await repo.getSite('site-1', { includeJson: true });

        expect(queryMock).toHaveBeenCalledTimes(2);
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
            mockSiteLoad([makeSiteRow()]);

            const first = await repo.getSite('site-1');
            const callCountAfterFirst = queryMock.mock.calls.length;
            expect(first?.id).toBe('site-1');
            expect(callCountAfterFirst).toBe(2);

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
            mockSiteLoad([makeSiteRow()]);
            await repo.getSite('site-1');
        });

        // Second request: invalidate persistent cache — must re-query
        await withRequestContext(async () => {
            const repo = new SiteRepo();
            repo.invalidateCache('site-1');
            queryMock.mockReset();
            mockSiteLoad([makeSiteRow()]);

            await repo.getSite('site-1');
            expect(queryMock.mock.calls.length).toBe(2); // hit DB, not request cache
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

    it('assembles a site with no tariffs (empty tariff query)', async () => {
        mockSiteLoad([makeSiteRow()]);

        const repo = new SiteRepo();
        const [site] = await repo.getSitesWithTariffs(['site-1'], { includeTokens: true });

        expect(site.id).toBe('site-1');
        expect(site.tariffs).toEqual([]);
        expect(site.name).toBe('Home');
        expect(site.timezone).toBe('America/Chicago');
        expect(site.access_token).toBe('a');
        expect(site.auth_status).toBe('active');
        expect(queryMock).toHaveBeenCalledTimes(2);
    });

    it('assembles a site with one tariff, one season, two schedules', async () => {
        const base = makeTariffJoinRow({
            season_id: 10,
            season_name: 'Summer',
            from_month: 6, from_day: 1,
            to_month: 9, to_day: 30,
            season_buy_rate: 0.40, season_sell_rate: 0.10,
        });
        mockSiteLoad([makeSiteRow()], [
            { ...base, schedule_id: 100, schedule_name: 'Peak',     schedule_buy_rate: 0.45, schedule_sell_rate: 0.08,
              from_day_of_week: 0, from_hour: 16, from_minute: 0, to_day_of_week: 6, to_hour: 21, to_minute: 0 },
            { ...base, schedule_id: 101, schedule_name: 'Off-Peak', schedule_buy_rate: 0.25, schedule_sell_rate: 0.10,
              from_day_of_week: 0, from_hour: 21, from_minute: 0, to_day_of_week: 6, to_hour: 16, to_minute: 0 },
        ]);

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
        expect(queryMock).toHaveBeenCalledTimes(2);
    });

    it('fetches two sites in one load', async () => {
        mockSiteLoad([
            makeSiteRow({ id: 'site-1', name: 'Home'  }),
            makeSiteRow({ id: 'site-2', name: 'Cabin', user_id: 'user-2' }),
        ]);

        const repo = new SiteRepo();
        const sites = await repo.getSitesWithTariffs(['site-1', 'site-2']);

        expect(sites).toHaveLength(2);
        expect(queryMock).toHaveBeenCalledTimes(2);
        const [, params] = queryMock.mock.calls[0] as [string, unknown[]];
        expect(params).toEqual([['site-1', 'site-2']]);
    });

    it('only fetches uncached ids when some are already in module cache', async () => {
        // Pre-populate module cache for site-1
        mockSiteLoad([makeSiteRow({ id: 'site-1' })]);
        const repo = new SiteRepo();
        await repo.getSitesWithTariffs(['site-1']);
        queryMock.mockReset();

        // Now request site-1 (cached) and site-2 (cold)
        mockSiteLoad([makeSiteRow({ id: 'site-2', name: 'Cabin' })]);
        const sites = await repo.getSitesWithTariffs(['site-1', 'site-2']);

        expect(sites).toHaveLength(2);
        expect(queryMock).toHaveBeenCalledTimes(2);
        const [, params] = queryMock.mock.calls[0] as [string, unknown[]];
        expect(params).toEqual([['site-2']]); // only the cold id
    });

    it('returns all from cache without querying when all ids are warm', async () => {
        // Warm both sites
        mockSiteLoad([
            makeSiteRow({ id: 'site-1' }),
            makeSiteRow({ id: 'site-2', name: 'Cabin' }),
        ]);
        const repo = new SiteRepo();
        await repo.getSitesWithTariffs(['site-1', 'site-2']);
        queryMock.mockReset();

        const sites = await repo.getSitesWithTariffs(['site-1', 'site-2']);
        expect(sites).toHaveLength(2);
        expect(queryMock).not.toHaveBeenCalled();
    });

    it('re-fetches when cached entry lacks json and includeJson is requested', async () => {
        // Warm cache without json
        mockSiteLoad([makeSiteRow()]);
        const repo = new SiteRepo();
        await repo.getSitesWithTariffs(['site-1']);
        queryMock.mockReset();

        // Request with includeJson — must hit DB because cached entry has no json
        mockSiteLoad([makeSiteRow({ json: { components: { battery: true } } })]);
        const [site] = await repo.getSitesWithTariffs(['site-1'], { includeJson: true });

        expect(queryMock).toHaveBeenCalledTimes(2);
        expect(site.json).toEqual({ components: { battery: true } });
    });

    it('always hits DB when includeTokens is requested, bypassing the cache', async () => {
        let loadCalls = 0;
        queryMock.mockImplementation(async (sql: string) => {
            if (String(sql).includes('FROM "Site"')) loadCalls++;
            return { rows: String(sql).includes('FROM "Site"') ? [makeSiteRow()] : [] };
        });

        const repo = new SiteRepo();

        // First call with includeTokens — hits DB
        await repo.getSitesWithTariffs(['site-1'], { includeTokens: true });
        expect(loadCalls).toBe(1);

        // Second call with includeTokens — must hit DB again, not use cache,
        // because auth_status can change externally (e.g., via recovery scripts)
        const [site] = await repo.getSitesWithTariffs(['site-1'], { includeTokens: true });
        expect(loadCalls).toBe(2);
        expect(site.access_token).toBe('a');
        expect(site.auth_status).toBe('active');
    });

    it('does not pollute global cache with includeTokens results', async () => {
        let loadCalls = 0;
        queryMock.mockImplementation(async (sql: string) => {
            if (String(sql).includes('FROM "Site"')) loadCalls++;
            return { rows: String(sql).includes('FROM "Site"') ? [makeSiteRow()] : [] };
        });

        const repo = new SiteRepo();

        // Request with includeTokens
        await repo.getSitesWithTariffs(['site-1'], { includeTokens: true });
        expect(loadCalls).toBe(1);

        // Subsequent request without includeTokens should still hit DB —
        // the previous includeTokens fetch should not have populated the cache
        await repo.getSitesWithTariffs(['site-1']);
        expect(loadCalls).toBe(2);
    });
});

describe('SiteRepo new commands and queries', () => {
    beforeEach(() => {
        queryMock.mockReset();
    });

    it('assignSiteToUser updates Site.user_id', async () => {
        queryMock.mockResolvedValueOnce({ rows: [] });
        const repo = new SiteRepo();
        await repo.assignSiteToUser('site-1', 'user-1');
        expect(queryMock).toHaveBeenCalledWith(
            'UPDATE "Site" SET user_id = $1 WHERE id = $2',
            ['user-1', 'site-1']
        );
    });

    it('getSiteJson returns parsed json blob', async () => {
        queryMock.mockResolvedValueOnce({ rows: [{ json: { site_name: 'Home' } }] });
        const repo = new SiteRepo();
        const result = await repo.getSiteJson('site-1');
        expect(result).toEqual({ site_name: 'Home' });
        expect(queryMock).toHaveBeenCalledWith(
            'SELECT json FROM "Site" WHERE id = $1',
            ['site-1']
        );
    });

    it('getSiteJson returns null when row missing', async () => {
        queryMock.mockResolvedValueOnce({ rows: [] });
        const repo = new SiteRepo();
        expect(await repo.getSiteJson('missing')).toBeNull();
    });

    it('upsertSite issues INSERT ... ON CONFLICT', async () => {
        queryMock.mockResolvedValueOnce({ rows: [] });
        const repo = new SiteRepo();
        const installed = new Date('2024-01-01T00:00:00Z');
        await repo.upsertSite({
            id: 'site-1',
            name: 'Home',
            utility: 'PG&E',
            installed,
            timezone: 'America/Chicago',
            json: { foo: 'bar' },
        });
        const [sql, args] = queryMock.mock.calls[0];
        expect(sql).toContain('INSERT INTO "Site"');
        expect(sql).toContain('ON CONFLICT(id) DO UPDATE');
        expect(args).toEqual([
            'site-1', 'Home', 'PG&E', installed, 'America/Chicago', JSON.stringify({ foo: 'bar' }), true
        ]);
    });

    it('upsertSite defaults missing/null name, timezone, and installed date to prevent NOT NULL DB errors', async () => {
        queryMock.mockResolvedValueOnce({ rows: [] });
        const repo = new SiteRepo();
        await repo.upsertSite({
            id: 'site-2',
            name: null,
            utility: null,
            installed: null,
            timezone: undefined,
            json: null,
        });
        const [sql, args] = queryMock.mock.calls[0];
        expect(sql).toContain('INSERT INTO "Site"');
        expect(args[0]).toBe('site-2');
        expect(args[1]).toBe('Unnamed Site'); // Default name
        expect(args[2]).toBeNull();
        expect(args[3]).toBeDefined(); // Default ISO timestamp string
        expect(args[4]).toBe('UTC'); // Default timezone
        expect(args[5]).toBe(JSON.stringify({}));
        expect(args[6]).toBe(false); // hasInstalled is false
    });


    it('updateLiveStatusCache updates the live status columns and invalidates the cache', async () => {
        queryMock.mockResolvedValueOnce({ rows: [] });
        const repo = new SiteRepo();
        const testStatus = { percentage_charged: 80 };
        await repo.updateLiveStatusCache('site-1', testStatus, 1234567890);
        
        expect(queryMock).toHaveBeenCalledWith(
            expect.stringMatching(/UPDATE\s+"Site"\s+SET\s+live_status_cache\s*=\s*\$1,\s*last_live_refresh_at\s*=\s*\$2/i),
            [JSON.stringify(testStatus), 1234567890, 'site-1']
        );
    });
});

describe('SiteRepo current-version tariff filter', () => {
    beforeEach(() => {
        queryMock.mockReset();
        new SiteRepo().invalidateCache('site-1');
    });

    it('joins only the current tariff version', async () => {
        mockSiteLoad([]);
        await new SiteRepo().getSite('site-1');
        const sql = String(queryMock.mock.calls.at(-1)?.[0] ?? '');
        expect(sql).toContain('FROM "Tariff"');
        expect(sql).toContain('t.is_current');
    });
});

describe('SiteRepo live refresh claim', () => {
    beforeEach(() => {
        queryMock.mockReset();
    });

    it('claimLiveRefresh returns true when the conditional update wins the row', async () => {
        queryMock.mockResolvedValueOnce({ rowCount: 1 });
        const repo = new SiteRepo();

        const claimed = await repo.claimLiveRefresh('site-1', 1_000_000, 60_000);

        expect(claimed).toBe(true);
        expect(queryMock).toHaveBeenCalledWith(
            expect.stringContaining('SET last_live_claim_at = $1'),
            [1_000_000, 'site-1', 940_000]
        );
        expect(queryMock.mock.calls[0][0]).toContain('last_live_claim_at IS NULL OR last_live_claim_at <= $3');
    });

    it('claimLiveRefresh returns false when another instance holds a fresh claim', async () => {
        queryMock.mockResolvedValueOnce({ rowCount: 0 });
        const repo = new SiteRepo();

        await expect(repo.claimLiveRefresh('site-1', 1_000_000, 60_000)).resolves.toBe(false);
    });

    it('releaseLiveRefreshClaim restores the previous value only while our claim is still on the row', async () => {
        queryMock.mockResolvedValueOnce({ rowCount: 1 });
        const repo = new SiteRepo();

        await repo.releaseLiveRefreshClaim('site-1', 1_000_000, 900_000);

        expect(queryMock).toHaveBeenCalledWith(
            expect.stringContaining('WHERE id = $2 AND last_live_claim_at = $3'),
            [900_000, 'site-1', 1_000_000]
        );
    });

    it('releaseLiveRefreshClaim restores NULL when there was no previous refresh', async () => {
        queryMock.mockResolvedValueOnce({ rowCount: 1 });
        const repo = new SiteRepo();

        await repo.releaseLiveRefreshClaim('site-1', 1_000_000, null);

        expect(queryMock).toHaveBeenCalledWith(expect.any(String), [null, 'site-1', 1_000_000]);
    });
});


describe('SiteRepo.getSitesForGapHeal', () => {
    beforeEach(() => queryMock.mockReset());

    it('lists only recently used sites whose owner can call Tesla, least recently imported first', async () => {
        queryMock.mockResolvedValueOnce({ rows: [{ id: 'site-1', timezone: 'America/Chicago' }] });

        await expect(new SiteRepo().getSitesForGapHeal(1_000)).resolves.toEqual([{ id: 'site-1', timezone: 'America/Chicago' }]);
        const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
        expect(sql).toContain('SELECT s.id, s.timezone, s.installed');
        expect(sql).toContain('s.last_live_refresh_at >= $1');
        expect(params).toEqual([1_000]);
        expect(sql).toContain('u.is_active = true');
        expect(sql).toContain('u.refresh_token IS NOT NULL');
        expect(sql).toContain(`u.auth_status IS DISTINCT FROM 'revoked'`);
        expect(sql).toContain('ORDER BY s.last_import_at ASC NULLS FIRST');
    });
});

describe('SiteRepo history backfill start', () => {
    beforeEach(() => queryMock.mockReset());

    it('reads history_backfill_from, null when unset or the site is missing', async () => {
        const from = new Date('2023-11-29T06:00:00Z');
        queryMock.mockResolvedValueOnce({ rows: [{ history_backfill_from: from }] })
            .mockResolvedValueOnce({ rows: [{ history_backfill_from: null }] })
            .mockResolvedValueOnce({ rows: [] });
        const repo = new SiteRepo();

        await expect(repo.getHistoryBackfillFrom('site-1')).resolves.toEqual(from);
        await expect(repo.getHistoryBackfillFrom('site-1')).resolves.toBeNull();
        await expect(repo.getHistoryBackfillFrom('site-1')).resolves.toBeNull();
        expect(queryMock.mock.calls[0]).toEqual([expect.stringContaining('SELECT history_backfill_from FROM "Site" WHERE id = $1'), ['site-1']]);
    });

    it('only moves history_backfill_from forward', async () => {
        queryMock.mockResolvedValueOnce({ rowCount: 1 });
        const from = new Date('2023-11-29T06:00:00Z');

        await new SiteRepo().setHistoryBackfillFrom('site-1', from);

        const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
        expect(sql).toContain('SET history_backfill_from = $2');
        expect(sql).toContain('history_backfill_from IS NULL OR history_backfill_from < $2');
        expect(params).toEqual(['site-1', from]);
    });
});

describe('SiteRepo history migration status', () => {
    beforeEach(() => queryMock.mockReset());

    it('stamps history_migrated_at', async () => {
        queryMock.mockResolvedValueOnce({ rowCount: 1 });
        const at = new Date('2026-10-19T20:00:00Z');

        await new SiteRepo().setHistoryMigratedAt('site-1', at);

        expect(queryMock).toHaveBeenCalledWith(expect.stringContaining('SET history_migrated_at = $2'), ['site-1', at]);
    });

    it('lists every site with owner, migration marker and archive coverage', async () => {
        const row = {
            id: 'site-1', name: 'Home', timezone: 'America/Chicago', installed: new Date('2023-11-14T17:09:47Z'),
            owner_email: 'a@example.com', history_backfill_from: null, history_migrated_at: null,
            archived_days: 0, first_archived_day: null, last_archived_day: null,
            last_energy_at: new Date('2026-10-19T20:00:00Z'),
        };
        queryMock.mockResolvedValueOnce({ rows: [row] });

        await expect(new SiteRepo().getHistoryOverview()).resolves.toEqual([row]);
        const [sql] = queryMock.mock.calls[0] as [string];
        expect(sql).toContain('LEFT JOIN "User" u ON u.id = s.user_id');
        // Empty day records (Tesla answered with no samples) are not archived days.
        expect(sql).toContain(`FROM "EnergyDayArchive" WHERE status IS DISTINCT FROM 'empty' GROUP BY site_id`);
        expect(sql).toContain('COALESCE(a.archived_days, 0)');
        // Admin-only and wide: never select tokens, Site.json or the live status cache.
        expect(sql).not.toMatch(/token|json|live_status_cache/);
    });

    it('reads each site\'s latest stored sample from raw rows or day records by index', async () => {
        queryMock.mockResolvedValueOnce({ rows: [] });

        await new SiteRepo().getHistoryOverview();

        const [sql] = queryMock.mock.calls[0] as [string];
        expect(sql).toContain(`LEFT JOIN LATERAL (SELECT ${latestStoredSampleSql('s.id')} AS last_energy_at) e ON true`);
    });

    it('lists active unmigrated sites first, then inactive unmigrated, then migrated; oldest install first within each', async () => {
        queryMock.mockResolvedValueOnce({ rows: [] });

        await new SiteRepo().getHistoryOverview();

        const [sql] = queryMock.mock.calls[0] as [string];
        expect(sql.replace(/\s+/g, ' ')).toContain(
            "ORDER BY s.history_migrated_at IS NOT NULL, (e.last_energy_at >= now() - interval '7 days') IS NOT TRUE, s.installed ASC, s.id",
        );
    });
});
