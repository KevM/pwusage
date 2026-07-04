import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImportLockOptions, ImportLockResult } from './import-lock';
import type { EnergyHistoryEntry, EnergySiteLiveStatus } from './tesla-client';

interface ImportLockTestRepo {
    acquireImportLock(params: {
        siteId: string;
        lockId: string;
        lockDurationMs?: number;
        force?: boolean;
        minIntervalMs?: number;
    }): Promise<boolean>;
    releaseImportLock(siteId: string, lockId: string): Promise<boolean>;
}

const importLockMock = vi.hoisted(() => ({
    withImportLock: vi.fn(async <T>(
        siteRepo: ImportLockTestRepo,
        options: ImportLockOptions,
        callback: () => Promise<T>
    ): Promise<ImportLockResult<T>> => {
        const lockId = 'test-lock-id';
        const acquired = await siteRepo.acquireImportLock({
            siteId: options.siteId,
            lockId,
            lockDurationMs: options.lockDurationMs,
            force: options.force,
            minIntervalMs: options.minIntervalMs,
        });

        if (!acquired) {
            return { status: 'not-acquired' };
        }

        try {
            return { status: 'acquired', value: await callback() };
        } finally {
            await siteRepo.releaseImportLock(options.siteId, lockId);
        }
    }),
}));

const tokens = {
    access_token: 'access-token',
    refresh_token: 'refresh-token',
    user_id: 'user-1',
};

const userRepoMock = {
    getTokensForSite: vi.fn(),
};

const siteRepoMock = {
    acquireImportLock: vi.fn(),
    releaseImportLock: vi.fn(),
    getImportStatus: vi.fn(),
    getSite: vi.fn(),
    updateLiveStatusCache: vi.fn(),
    claimLiveRefresh: vi.fn(),
    releaseLiveRefreshClaim: vi.fn(),
};

const energyRepoMock = {
    getLatestEnergyData: vi.fn(),
};

const tokenRefreshHandlers = {
    refreshHandler: vi.fn(),
    errorHandler: vi.fn(),
};

const teslaTokenRepoMock = {
    getLockedRefreshHandler: vi.fn(),
};

const teslaClientMock = {
    getLiveStatus: vi.fn(),
};

const importerMock = {
    getTodayData: vi.fn(),
    persistHistory: vi.fn(),
};

vi.mock('./user-repo', () => ({
    UserRepo: vi.fn(function UserRepo() {
        return userRepoMock;
    }),
}));

vi.mock('./site-repo', () => ({
    SiteRepo: vi.fn(function SiteRepo() {
        return siteRepoMock;
    }),
}));

vi.mock('./energy-repo', () => ({
    EnergyRepo: vi.fn(function EnergyRepo() {
        return energyRepoMock;
    }),
}));

vi.mock('./tesla-token-repo', () => ({
    TeslaTokenRepo: vi.fn(function TeslaTokenRepo() {
        return teslaTokenRepoMock;
    }),
}));

vi.mock('./tesla-client', () => ({
    TeslaClient: vi.fn(function TeslaClient() {
        return teslaClientMock;
    }),
}));

vi.mock('./importer', () => ({
    Importer: vi.fn(function Importer() {
        return importerMock;
    }),
}));

vi.mock('./import-lock', () => ({
    withImportLock: importLockMock.withImportLock,
}));

describe('refreshTodayData', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        delete (globalThis as unknown as { __todayRefreshState?: Map<string, unknown> }).__todayRefreshState;

        userRepoMock.getTokensForSite.mockResolvedValue(tokens);
        siteRepoMock.acquireImportLock.mockResolvedValue(true);
        siteRepoMock.releaseImportLock.mockResolvedValue(true);
        siteRepoMock.getImportStatus.mockResolvedValue({ isImporting: false, lastImportAt: 0 });
        siteRepoMock.getSite.mockResolvedValue({
            id: 'site-1',
            live_status_cache: null,
            last_live_refresh_at: null,
        });
        siteRepoMock.updateLiveStatusCache.mockResolvedValue(undefined);
        siteRepoMock.claimLiveRefresh.mockResolvedValue(true);
        siteRepoMock.releaseLiveRefreshClaim.mockResolvedValue(undefined);
        energyRepoMock.getLatestEnergyData.mockResolvedValue(null);
        teslaTokenRepoMock.getLockedRefreshHandler.mockReturnValue(tokenRefreshHandlers);
        teslaClientMock.getLiveStatus.mockResolvedValue({ percentage_charged: 72 });
        importerMock.getTodayData.mockResolvedValue([]);
        importerMock.persistHistory.mockResolvedValue(0);
    });

    async function importRefreshTodayData() {
        return import('./today-refresh');
    }

    it('returns no-tokens without acquiring a DB lock when Tesla tokens are missing', async () => {
        userRepoMock.getTokensForSite.mockResolvedValue(null);
        const { refreshTodayData } = await importRefreshTodayData();

        await expect(refreshTodayData('site-1')).resolves.toEqual({ status: 'no-tokens' });
        expect(siteRepoMock.acquireImportLock).not.toHaveBeenCalled();
    });

    it('maps an active DB lock to in-flight', async () => {
        siteRepoMock.acquireImportLock.mockResolvedValue(false);
        siteRepoMock.getImportStatus.mockResolvedValue({ isImporting: true, lastImportAt: Date.now() });
        const { refreshTodayData } = await importRefreshTodayData();

        await expect(refreshTodayData('site-1')).resolves.toEqual({ status: 'in-flight' });
    });

    it('fetches today rows, persists through Importer, and releases the DB lock', async () => {
        const rows: EnergyHistoryEntry[] = [
            {
                site_id: 'site-1',
                timestamp: new Date('2026-07-02T10:05:00Z'),
            } as unknown as EnergyHistoryEntry,
        ];
        energyRepoMock.getLatestEnergyData.mockResolvedValue({ timestamp: new Date('2026-07-02T10:00:00Z') });
        importerMock.getTodayData.mockResolvedValue(rows);
        importerMock.persistHistory.mockResolvedValue(1);
        const { refreshTodayData } = await importRefreshTodayData();

        await expect(refreshTodayData('site-1')).resolves.toMatchObject({ status: 'persisted', rowsPersisted: 1 });
        expect(importLockMock.withImportLock).toHaveBeenCalledWith(
            siteRepoMock,
            expect.objectContaining({
                siteId: 'site-1',
                lockDurationMs: 60000,
                minIntervalMs: 60000,
                logLabel: 'TodayRefresh',
            }),
            expect.any(Function)
        );
        expect(siteRepoMock.releaseImportLock).toHaveBeenCalledWith('site-1', expect.any(String));
    });

    it('returns error and still releases the lock when Tesla fetch fails', async () => {
        importerMock.getTodayData.mockRejectedValue(new Error('tesla down'));
        const { refreshTodayData } = await importRefreshTodayData();

        await expect(refreshTodayData('site-1')).resolves.toMatchObject({ status: 'error', errorMessage: 'tesla down' });
        expect(siteRepoMock.releaseImportLock).toHaveBeenCalledWith('site-1', expect.any(String));
    });
});

describe('refreshLiveStatus', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        delete (globalThis as unknown as { __todayRefreshState?: Map<string, unknown> }).__todayRefreshState;

        userRepoMock.getTokensForSite.mockResolvedValue(tokens);
        siteRepoMock.getSite.mockResolvedValue({
            id: 'site-1',
            live_status_cache: null,
            last_live_refresh_at: null,
        });
        siteRepoMock.updateLiveStatusCache.mockResolvedValue(undefined);
        siteRepoMock.claimLiveRefresh.mockResolvedValue(true);
        siteRepoMock.releaseLiveRefreshClaim.mockResolvedValue(undefined);
        teslaTokenRepoMock.getLockedRefreshHandler.mockReturnValue(tokenRefreshHandlers);
        teslaClientMock.getLiveStatus.mockResolvedValue({ percentage_charged: 72 });
    });

    async function importRefreshLiveStatus() {
        return import('./today-refresh');
    }

    it('refreshLiveStatus returns cached status when the live cache is fresh', async () => {
        siteRepoMock.getSite.mockResolvedValue({
            id: 'site-1',
            live_status_cache: { percentage_charged: 61 },
            last_live_refresh_at: Date.now(),
        });
        const { refreshLiveStatus } = await importRefreshLiveStatus();

        await expect(refreshLiveStatus('site-1')).resolves.toEqual({
            status: 'cached',
            liveStatus: { percentage_charged: 61 },
            fetchedAt: expect.any(Number),
        });
        expect(teslaClientMock.getLiveStatus).not.toHaveBeenCalled();
    });

    it('refreshLiveStatus fetches from Tesla and updates the Site live cache', async () => {
        const liveStatus = { percentage_charged: 72 } as unknown as EnergySiteLiveStatus;
        siteRepoMock.getSite.mockResolvedValue({ id: 'site-1', live_status_cache: null, last_live_refresh_at: null });
        userRepoMock.getTokensForSite.mockResolvedValue(tokens);
        teslaClientMock.getLiveStatus.mockResolvedValue(liveStatus);
        const { refreshLiveStatus } = await importRefreshLiveStatus();

        await expect(refreshLiveStatus('site-1', { cacheTtlMs: 16 * 60 * 1000 })).resolves.toMatchObject({
            status: 'refreshed',
            liveStatus: { percentage_charged: 72 },
        });
        expect(siteRepoMock.updateLiveStatusCache).toHaveBeenCalledWith('site-1', liveStatus, expect.any(Number));
    });

    it('refreshLiveStatus returns no-tokens without fetching Tesla', async () => {
        siteRepoMock.getSite.mockResolvedValue({ id: 'site-1', live_status_cache: null, last_live_refresh_at: null });
        userRepoMock.getTokensForSite.mockResolvedValue(null);
        const { refreshLiveStatus } = await importRefreshLiveStatus();

        await expect(refreshLiveStatus('site-1')).resolves.toEqual({ status: 'no-tokens' });
        expect(teslaClientMock.getLiveStatus).not.toHaveBeenCalled();
    });

    it('refreshLiveStatus returns error on Tesla failure', async () => {
        siteRepoMock.getSite.mockResolvedValue({ id: 'site-1', live_status_cache: null, last_live_refresh_at: null });
        userRepoMock.getTokensForSite.mockResolvedValue(tokens);
        teslaClientMock.getLiveStatus.mockRejectedValue(new Error('live down'));
        const { refreshLiveStatus } = await importRefreshLiveStatus();

        await expect(refreshLiveStatus('site-1')).resolves.toMatchObject({ status: 'error', errorMessage: 'live down' });
    });

    it('does not report in-flight or lock out cold cache retries after a failed fetch', async () => {
        siteRepoMock.getSite.mockResolvedValue({ id: 'site-1', live_status_cache: null, last_live_refresh_at: null });
        userRepoMock.getTokensForSite.mockResolvedValue(tokens);
        teslaClientMock.getLiveStatus.mockRejectedValueOnce(new Error('timeout'));

        const { refreshLiveStatus } = await importRefreshLiveStatus();

        const firstResult = await refreshLiveStatus('site-1');
        expect(firstResult).toMatchObject({ status: 'error', errorMessage: 'timeout' });

        // Subsequent call should NOT return 'in-flight' and should attempt fetch again
        const liveStatus = { percentage_charged: 80 } as unknown as EnergySiteLiveStatus;
        teslaClientMock.getLiveStatus.mockResolvedValueOnce(liveStatus);

        const secondResult = await refreshLiveStatus('site-1');
        expect(secondResult).toMatchObject({ status: 'refreshed', liveStatus });
    });

    it('honors caller cacheTtlMs override for re-fetching after short interval', async () => {
        const liveStatus1 = { percentage_charged: 80 } as unknown as EnergySiteLiveStatus;
        const liveStatus2 = { percentage_charged: 85 } as unknown as EnergySiteLiveStatus;

        siteRepoMock.getSite.mockResolvedValue({ id: 'site-1', live_status_cache: null, last_live_refresh_at: null });
        userRepoMock.getTokensForSite.mockResolvedValue(tokens);
        teslaClientMock.getLiveStatus.mockResolvedValueOnce(liveStatus1);

        const { refreshLiveStatus } = await importRefreshLiveStatus();

        const now = Date.now();
        vi.useFakeTimers();
        vi.setSystemTime(now);

        const firstResult = await refreshLiveStatus('site-1', { cacheTtlMs: 60 * 1000 });
        expect(firstResult).toMatchObject({ status: 'refreshed', liveStatus: liveStatus1 });

        // Simulate site DB cache updated with first result at now
        siteRepoMock.getSite.mockResolvedValue({ id: 'site-1', live_status_cache: liveStatus1, last_live_refresh_at: now });

        // 30 seconds later: cache hit
        vi.setSystemTime(now + 30 * 1000);
        const hitResult = await refreshLiveStatus('site-1', { cacheTtlMs: 60 * 1000 });
        expect(hitResult).toMatchObject({ status: 'cached', liveStatus: liveStatus1 });
        expect(teslaClientMock.getLiveStatus).toHaveBeenCalledTimes(1);

        // 65 seconds later: cache expired, re-fetches from Tesla
        vi.setSystemTime(now + 65 * 1000);
        teslaClientMock.getLiveStatus.mockResolvedValueOnce(liveStatus2);
        const secondResult = await refreshLiveStatus('site-1', { cacheTtlMs: 60 * 1000 });
        expect(secondResult).toMatchObject({ status: 'refreshed', liveStatus: liveStatus2 });
        expect(teslaClientMock.getLiveStatus).toHaveBeenCalledTimes(2);

        vi.useRealTimers();
    });

    it('createTeslaClientForSite allows creation when access_token is empty if refresh_token exists', async () => {
        userRepoMock.getTokensForSite.mockResolvedValue({ access_token: '', refresh_token: 'valid-refresh-token' });
        const { createTeslaClientForSite } = await import('./tesla-client-factory');

        const client = await createTeslaClientForSite('site-1');
        expect(client).not.toBeNull();
    });

    it('sets liveInFlight before awaiting tokens to block concurrent requests during token lookup', async () => {
        siteRepoMock.getSite.mockResolvedValue({ id: 'site-1', live_status_cache: null, last_live_refresh_at: null });
        
        let resolveTokens: (val: typeof tokens) => void;
        userRepoMock.getTokensForSite.mockReturnValue(new Promise((resolve) => {
            resolveTokens = resolve;
        }));

        const { refreshLiveStatus } = await importRefreshLiveStatus();

        const firstPromise = refreshLiveStatus('site-1');

        // Second call arrives while first call is awaiting getTokensForSite
        const secondResult = await refreshLiveStatus('site-1');
        expect(secondResult).toEqual({ status: 'in-flight' });

        // Resolve first call
        resolveTokens!(tokens);
        await expect(firstPromise).resolves.toMatchObject({ status: 'refreshed' });
    });

    it('returns throttled without calling Tesla when another instance holds the claim', async () => {
        siteRepoMock.claimLiveRefresh.mockResolvedValue(false);
        const { refreshLiveStatus } = await importRefreshLiveStatus();

        await expect(refreshLiveStatus('site-1')).resolves.toEqual({ status: 'throttled' });
        expect(teslaClientMock.getLiveStatus).not.toHaveBeenCalled();
    });

    it('returns the stale cache when the claim is lost but a cache exists', async () => {
        siteRepoMock.getSite.mockResolvedValue({
            id: 'site-1',
            live_status_cache: { percentage_charged: 55 },
            last_live_refresh_at: Date.now() - 17 * 60 * 1000, // expired vs 16-min TTL
        });
        siteRepoMock.claimLiveRefresh.mockResolvedValue(false);
        const { refreshLiveStatus } = await importRefreshLiveStatus();

        await expect(refreshLiveStatus('site-1')).resolves.toMatchObject({
            status: 'cached',
            liveStatus: { percentage_charged: 55 },
        });
        expect(teslaClientMock.getLiveStatus).not.toHaveBeenCalled();
    });

    it('releases the claim when the Tesla fetch fails', async () => {
        const previous = Date.now() - 20 * 60 * 1000;
        siteRepoMock.getSite.mockResolvedValue({
            id: 'site-1',
            live_status_cache: null,
            last_live_refresh_at: previous,
        });
        teslaClientMock.getLiveStatus.mockRejectedValue(new Error('live down'));
        const { refreshLiveStatus } = await importRefreshLiveStatus();

        await expect(refreshLiveStatus('site-1')).resolves.toMatchObject({ status: 'error' });
        expect(siteRepoMock.releaseLiveRefreshClaim).toHaveBeenCalledWith('site-1', expect.any(Number), previous);
    });

    it('bypasses the claim when force is set', async () => {
        siteRepoMock.claimLiveRefresh.mockResolvedValue(false);
        const { refreshLiveStatus } = await importRefreshLiveStatus();

        await expect(refreshLiveStatus('site-1', { force: true })).resolves.toMatchObject({ status: 'refreshed' });
        expect(siteRepoMock.claimLiveRefresh).not.toHaveBeenCalled();
    });
});


