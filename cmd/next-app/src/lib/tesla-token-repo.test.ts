import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMock, refreshAccessTokenMock } = vi.hoisted(() => ({
    queryMock: vi.fn(),
    refreshAccessTokenMock: vi.fn(),
}));

vi.mock('./db', () => ({
    pool: { query: queryMock }
}));

vi.mock('./tesla-auth', () => ({
    refreshAccessToken: refreshAccessTokenMock,
}));

import { TeslaTokenRepo } from './tesla-token-repo';
import { SiteRepo } from './site-repo';

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

describe('TeslaTokenRepo.waitForTokenRefresh', () => {
    let siteRepo: SiteRepo;
    let tokenRepo: TeslaTokenRepo;

    beforeEach(() => {
        queryMock.mockReset();
        siteRepo = new SiteRepo();
        siteRepo.invalidateCache('site-1');
        tokenRepo = new TeslaTokenRepo(siteRepo);
    });

    it('throws when a concurrent refresh failed and left auth_status revoked', async () => {
        // getSite JOIN query — only user_id matters here
        queryMock.mockResolvedValueOnce({ rows: [makeSiteJoinRow()] });
        // User polling: lock released, but the refresh that held it failed → revoked
        queryMock.mockResolvedValueOnce({
            rows: [{ access_token: 'old-token', refresh_token: 'old-refresh', is_refreshing: 0, auth_status: 'revoked' }]
        });

        await expect(tokenRepo.waitForTokenRefresh('site-1')).rejects.toThrow('auth revoked');
    });

    it('returns new tokens when a concurrent refresh succeeded', async () => {
        // getSite JOIN query
        queryMock.mockResolvedValueOnce({ rows: [makeSiteJoinRow()] });
        // User polling: lock released, refresh succeeded
        queryMock.mockResolvedValueOnce({
            rows: [{ access_token: 'new-token', refresh_token: 'new-refresh', is_refreshing: 0, auth_status: 'active' }]
        });

        const tokens = await tokenRepo.waitForTokenRefresh('site-1');
        expect(tokens.access_token).toBe('new-token');
        expect(tokens.refresh_token).toBe('new-refresh');
    });
});

describe('getLockedRefreshHandler', () => {
    let siteRepo: SiteRepo;
    let tokenRepo: TeslaTokenRepo;

    beforeEach(() => {
        queryMock.mockReset();
        refreshAccessTokenMock.mockReset();
        siteRepo = new SiteRepo();
        siteRepo.invalidateCache('site-1');
        tokenRepo = new TeslaTokenRepo(siteRepo);
    });

    it('atomically revokes and releases lock on terminal failure so waiters cannot observe the unlocked-without-revoked state', async () => {
        // getSite JOIN (for acquireRefreshLock; result is cached, so only one DB call for getSite)
        queryMock.mockResolvedValueOnce({ rows: [makeSiteJoinRow()], rowCount: 1 });
        // acquireRefreshLock UPDATE → lock acquired
        queryMock.mockResolvedValueOnce({ rowCount: 1 });
        // atomic revoke+release UPDATE
        queryMock.mockResolvedValueOnce({ rowCount: 1 });

        refreshAccessTokenMock.mockRejectedValueOnce(new Error('Tesla: 401 Unauthorized invalid_grant'));

        const handlers = tokenRepo.getLockedRefreshHandler('site-1');
        await expect(handlers.refreshHandler('old-refresh')).rejects.toThrow();

        // Find the query that releases the lock (sets is_refreshing = 0 in SET clause, not WHERE).
        // The acquire query has is_refreshing = 1 in SET, so exclude any call containing that.
        const lockReleaseCall = queryMock.mock.calls.find(
            (call) =>
                typeof call[0] === 'string' &&
                (call[0] as string).includes('is_refreshing = 0') &&
                !(call[0] as string).includes('is_refreshing = 1'),
        );
        expect(lockReleaseCall, 'expected a query that releases the lock').toBeDefined();
        expect(lockReleaseCall![0], 'lock-release query must atomically set auth_status').toMatch(/auth_status/);
        expect(lockReleaseCall![1], 'auth_status value must be "revoked"').toContain('revoked');
    });

    it('releases lock normally on non-terminal (transient) failure', async () => {
        // getSite cached after acquireRefreshLock's first call, so releaseRefreshLock hits cache
        queryMock.mockResolvedValueOnce({ rows: [makeSiteJoinRow()], rowCount: 1 }); // getSite
        queryMock.mockResolvedValueOnce({ rowCount: 1 }); // acquireRefreshLock UPDATE
        queryMock.mockResolvedValueOnce({ rowCount: 1 }); // releaseRefreshLock UPDATE

        refreshAccessTokenMock.mockRejectedValueOnce(new Error('Network timeout'));

        const handlers = tokenRepo.getLockedRefreshHandler('site-1');
        await expect(handlers.refreshHandler('old-refresh')).rejects.toThrow();

        const lockReleaseCall = queryMock.mock.calls.find(
            (call) =>
                typeof call[0] === 'string' &&
                (call[0] as string).includes('is_refreshing = 0') &&
                !(call[0] as string).includes('is_refreshing = 1'),
        );
        expect(lockReleaseCall, 'expected a normal lock-release query').toBeDefined();
        // auth_status must NOT be touched — just a plain release for transient failures
        expect(lockReleaseCall![0], 'non-terminal release must not touch auth_status').not.toMatch(/auth_status/);
    });
});
