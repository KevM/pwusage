import { TeslaRefreshError, TeslaConnectionRequiredError, TeslaRefreshBackoffError } from './tesla-refresh-outcome';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMock, refreshAccessTokenMock, userRepoUpdateTokensMock, userRepoUpdateUserStatusMock } = vi.hoisted(() => ({
    queryMock: vi.fn(),
    refreshAccessTokenMock: vi.fn(),
    userRepoUpdateTokensMock: vi.fn(),
    userRepoUpdateUserStatusMock: vi.fn(),
}));

vi.mock('./db', () => ({
    pool: { query: queryMock }
}));

vi.mock('./tesla-auth', async importOriginal => ({
    ...await importOriginal<typeof import('./tesla-auth')>(),
    refreshAccessToken: refreshAccessTokenMock,
}));

vi.mock('./user-repo', () => ({
    UserRepo: vi.fn(),
}));

import { TeslaTokenRepo } from './tesla-token-repo';
import { SiteRepo } from './site-repo';
import { UserRepo } from './user-repo';
import { isTeslaAuthError } from './tesla-client';

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

describe('TeslaTokenRepo refresh wait', () => {
    let tokenRepo: TeslaTokenRepo;

    beforeEach(() => {
        queryMock.mockReset();
        refreshAccessTokenMock.mockReset();
        tokenRepo = new TeslaTokenRepo(new SiteRepo());
    });

    // The claim matches nothing, so the caller polls the account row.
    function unclaimed(row: Record<string, unknown> | undefined) {
        queryMock.mockResolvedValueOnce({ rowCount: 0, rows: [] });
        queryMock.mockResolvedValueOnce({ rows: row ? [row] : [] });
        return tokenRepo.getLockedUserRefreshHandler('user-1').refreshHandler('old-refresh');
    }

    it('throws when a concurrent refresh failed and left auth_status revoked', async () => {
        const error = await unclaimed({ access_token: 'old-token', refresh_token: 'old-refresh', is_refreshing: 0, auth_status: 'revoked' })
            .catch((error: unknown) => error);
        expect(error).toBeInstanceOf(TeslaConnectionRequiredError);
        expect(isTeslaAuthError(error)).toBe(false);
    });

    it('returns new tokens when a concurrent refresh succeeded', async () => {
        const tokens = await unclaimed({ access_token: 'new-token', refresh_token: 'new-refresh', is_refreshing: 0, auth_status: 'active', tesla_refresh_state: 'ready' });
        expect(tokens).toEqual({ access_token: 'new-token', refresh_token: 'new-refresh' });
        expect(refreshAccessTokenMock).not.toHaveBeenCalled();
    });

    it('fails fast with a backoff while the stored grant is cooling down', async () => {
        const retryAfter = Date.now() + 60_000;
        const error = await unclaimed({ access_token: 'old-token', refresh_token: 'old-refresh', is_refreshing: 0, auth_status: 'error', tesla_refresh_state: 'ready', tesla_refresh_retry_after: String(retryAfter) })
            .catch((error: unknown) => error);
        expect(error).toBeInstanceOf(TeslaRefreshBackoffError);
        expect((error as TeslaRefreshBackoffError).retryAfter).toBe(retryAfter);
        expect(refreshAccessTokenMock).not.toHaveBeenCalled();
    });

    it('throws a clean error when the user row no longer exists', async () => {
        await expect(unclaimed(undefined)).rejects.toThrow('Token refresh wait failed: user not found');
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
        // getSite (for acquireRefreshLock; result is cached, so only one DB load for getSite)
        queryMock.mockResolvedValueOnce({ rows: [makeSiteJoinRow()], rowCount: 1 });
        queryMock.mockResolvedValueOnce({ rows: [] }); // tariff tree query
        // acquireRefreshLock UPDATE → lock acquired
        queryMock.mockResolvedValueOnce({ rowCount: 1, rows: [{ access_token: 'old-token', refresh_token: 'old-refresh' }] });
        // atomic revoke+release UPDATE
        queryMock.mockResolvedValueOnce({ rowCount: 1 });
        queryMock.mockResolvedValue({ rowCount: 0, rows: [] });

        refreshAccessTokenMock.mockRejectedValueOnce(new TeslaRefreshError('credential_rejected'));

        const handlers = tokenRepo.getLockedRefreshHandler('site-1');
        await expect(handlers.refreshHandler('old-refresh')).rejects.toThrow();

        // Find the query that releases the lock (sets is_refreshing = 0 in SET clause, not WHERE).
        // The acquire query has is_refreshing = 1 in SET, so exclude any call containing that.
        const lockReleaseCall = queryMock.mock.calls.find(
            (call) =>
                typeof call[0] === 'string' &&
                (call[0] as string).includes('is_refreshing = 0') &&
                !(call[0] as string).includes('SET is_refreshing = 1'),
        );
        expect(lockReleaseCall, 'expected a query that releases the lock').toBeDefined();
        expect(lockReleaseCall![1]).toContain('reconnect_required');
        expect(lockReleaseCall![0]).not.toContain('is_active = false');
    });

    it('does not re-submit a refresh token after a concurrent refresh revoked the user', async () => {
        // A request that got its 401 before a concurrent refresh revoked the user
        // arrives after that refresh released the lock. It must not take the free
        // lock and send the same dead refresh token to Tesla again.
        const user = { is_refreshing: 0, auth_status: 'revoked' };
        queryMock.mockResolvedValueOnce({ rows: [makeSiteJoinRow()], rowCount: 1 }); // getSite site scalars
        queryMock.mockResolvedValueOnce({ rows: [] }); // getSite tariff tree
        queryMock.mockImplementation(async (sql: string) => {
            if (sql.includes('SET is_refreshing = 1')) {
                const excludesRevoked = /auth_status IS DISTINCT FROM 'revoked'/.test(sql);
                return { rowCount: user.is_refreshing === 0 && !(excludesRevoked && user.auth_status === 'revoked') ? 1 : 0 };
            }
            if (sql.includes('SELECT access_token')) {
                return { rows: [{ access_token: 'old-token', refresh_token: 'old-refresh', ...user }] };
            }
            return { rowCount: 1 };
        });

        const handlers = tokenRepo.getLockedRefreshHandler('site-1');
        await expect(handlers.refreshHandler('old-refresh')).rejects.toThrow('Reconnect Tesla');
        expect(refreshAccessTokenMock).not.toHaveBeenCalled();
    });

    it('releases lock normally on non-terminal (transient) failure', async () => {
        // getSite cached after acquireRefreshLock's first call, so releaseRefreshLock hits cache
        queryMock.mockResolvedValueOnce({ rows: [makeSiteJoinRow()], rowCount: 1 }); // getSite site scalars
        queryMock.mockResolvedValueOnce({ rows: [] }); // getSite tariff tree
        queryMock.mockResolvedValueOnce({ rowCount: 1, rows: [{ access_token: 'old-token', refresh_token: 'old-refresh' }] }); // claim snapshot
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
        // Connection health may record the outage, but account eligibility must not change.
        expect(lockReleaseCall![0]).not.toMatch(/is_active\s*=/);
    });
});

describe('TeslaTokenRepo delegates User writes to UserRepo', () => {
    let siteRepo: SiteRepo;
    let userRepo: { updateTokens: typeof userRepoUpdateTokensMock; updateUserStatus: typeof userRepoUpdateUserStatusMock };
    let tokenRepo: TeslaTokenRepo;

    beforeEach(() => {
        queryMock.mockReset();
        userRepoUpdateTokensMock.mockReset();
        userRepoUpdateUserStatusMock.mockReset();
        siteRepo = new SiteRepo();
        siteRepo.invalidateCache('site-1');
        userRepo = { updateTokens: userRepoUpdateTokensMock, updateUserStatus: userRepoUpdateUserStatusMock };
        tokenRepo = new TeslaTokenRepo(siteRepo, userRepo as unknown as UserRepo);
    });

    it('updateSiteTokens delegates to UserRepo.updateTokens', async () => {
        queryMock.mockResolvedValueOnce({ rows: [makeSiteJoinRow()] });
        queryMock.mockResolvedValueOnce({ rows: [] }); // tariff tree query

        await tokenRepo.updateSiteTokens('site-1', 'new-access', 'new-refresh');

        expect(userRepoUpdateTokensMock).toHaveBeenCalledWith('user-1', 'new-access', 'new-refresh');
    });

    it('refresh persists new tokens with credential and lease guards', async () => {
        // getSite for acquireRefreshLock — site scalars, then tariff tree
        queryMock.mockResolvedValueOnce({ rows: [makeSiteJoinRow()], rowCount: 1 });
        queryMock.mockResolvedValueOnce({ rows: [] });
        // acquireRefreshLock UPDATE
        queryMock.mockResolvedValueOnce({ rowCount: 1, rows: [{ access_token: 'old-token', refresh_token: 'old-refresh' }] });
        queryMock.mockResolvedValue({ rowCount: 1, rows: [] });

        refreshAccessTokenMock.mockResolvedValueOnce({ access_token: 'new-access', refresh_token: 'new-refresh' });

        const handlers = tokenRepo.getLockedRefreshHandler('site-1');
        await handlers.refreshHandler('old-refresh');

        // Guarded by credential generation and attempt, not the lease clock:
        // Tesla already consumed the old grant, so a slow save must still land.
        const save = queryMock.mock.calls.find(([sql]) => String(sql).includes('SET access_token = $1'));
        expect(save?.[0]).toContain('AND refresh_token = $4');
        expect(save?.[0]).toContain('tesla_refresh_attempt_id = $6');
        expect(save?.[0]).toContain('is_refreshing = 0, refresh_lock_expires = 0');
        expect(save?.[0]).not.toContain('refresh_lock_expires >');
        expect(save?.[1]).toEqual(['new-access', 'new-refresh', 'user-1', 'old-refresh', undefined, expect.any(String)]);
    });

    it('errorHandler does not revoke a login that completed after the refresh lease was released', async () => {
        // getSite for errorHandler — site scalars, then tariff tree
        queryMock.mockResolvedValueOnce({ rows: [makeSiteJoinRow()] });
        queryMock.mockResolvedValueOnce({ rows: [] });

        const handlers = tokenRepo.getLockedRefreshHandler('site-1');
        await handlers.errorHandler();

        expect(userRepoUpdateUserStatusMock).not.toHaveBeenCalled();
    });
});
