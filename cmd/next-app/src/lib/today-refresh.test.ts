import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    getLiveRefreshState: vi.fn(),
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
    refreshTodayRecords: vi.fn(),
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

const createEnergyRepoMock = vi.hoisted(() => vi.fn());

vi.mock('./energy-repo-factory', () => ({
    createEnergyRepo: createEnergyRepoMock,
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
            timezone: 'America/Chicago',
            live_status_cache: null,
            last_live_refresh_at: null,
        });
        createEnergyRepoMock.mockReturnValue(energyRepoMock);
        siteRepoMock.updateLiveStatusCache.mockResolvedValue(undefined);
        siteRepoMock.claimLiveRefresh.mockResolvedValue(true);
        siteRepoMock.releaseLiveRefreshClaim.mockResolvedValue(undefined);
        energyRepoMock.getLatestEnergyData.mockResolvedValue(null);
        teslaTokenRepoMock.getLockedRefreshHandler.mockReturnValue(tokenRefreshHandlers);
        teslaClientMock.getLiveStatus.mockResolvedValue({ percentage_charged: 72 });
        importerMock.refreshTodayRecords.mockResolvedValue({ rows: [], rowsPersisted: 0 });
    });

    async function importRefreshTodayData() {
        return import('./today-refresh');
    }

    it('cancels the entire history attempt and prevents late persistence', async () => {
        vi.useFakeTimers();
        try {
            let finish: ((result: { rows: Array<{ timestamp: Date }>; rowsPersisted: number }) => void) | undefined;
            importerMock.refreshTodayRecords.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
            const { refreshTodayData } = await importRefreshTodayData();
            const { ioSignal } = await import('./io-deadline');
            let signal: AbortSignal | undefined;
            energyRepoMock.getLatestEnergyData.mockImplementationOnce(async () => { signal = ioSignal(); return null; });
            const pending = refreshTodayData('site-1', { timeoutMs: 100 });
            await vi.advanceTimersByTimeAsync(100);
            expect((await pending).status).toBe('error');
            expect(signal?.aborted).toBe(true);
            finish?.({ rows: [{ timestamp: new Date() }], rowsPersisted: 1 }); await vi.runAllTimersAsync();
        } finally { vi.useRealTimers(); }
    });

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

    it('writes today\'s day record through Importer and releases the DB lock', async () => {
        const rows: EnergyHistoryEntry[] = [
            {
                site_id: 'site-1',
                timestamp: new Date('2026-07-02T10:05:00Z'),
            } as unknown as EnergyHistoryEntry,
        ];
        energyRepoMock.getLatestEnergyData.mockResolvedValue({ timestamp: new Date('2026-07-02T10:00:00Z') });
        importerMock.refreshTodayRecords.mockResolvedValue({ rows, rowsPersisted: 1 });
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

    it('passes the latest stored timestamp so the importer can backfill the previous day tail', async () => {
        const latest = new Date('2026-10-16T03:50:00Z');
        energyRepoMock.getLatestEnergyData.mockResolvedValue({ timestamp: latest });
        const { refreshTodayData } = await importRefreshTodayData();

        await refreshTodayData('site-1');
        expect(importerMock.refreshTodayRecords).toHaveBeenCalledWith('site-1', latest);
    });

    it('reads the latest stored sample through the compact-aware repo in the site timezone', async () => {
        const { refreshTodayData } = await importRefreshTodayData();

        await refreshTodayData('site-1');
        expect(siteRepoMock.getSite).toHaveBeenCalledWith('site-1');
        expect(createEnergyRepoMock).toHaveBeenCalledWith('America/Chicago');
        expect(energyRepoMock.getLatestEnergyData).toHaveBeenCalledWith('site-1');
    });

    it('skips the refresh when the site no longer exists', async () => {
        siteRepoMock.getSite.mockResolvedValue(undefined);
        const { refreshTodayData } = await importRefreshTodayData();

        await expect(refreshTodayData('site-1')).resolves.toEqual({ status: 'no-new-rows' });
        expect(importerMock.refreshTodayRecords).not.toHaveBeenCalled();
    });

    it('passes null when the site has no stored rows', async () => {
        const { refreshTodayData } = await importRefreshTodayData();

        await refreshTodayData('site-1');
        expect(importerMock.refreshTodayRecords).toHaveBeenCalledWith('site-1', null);
    });

    it('returns error and still releases the lock when Tesla fetch fails', async () => {
        importerMock.refreshTodayRecords.mockRejectedValue(new Error('tesla down'));
        const { refreshTodayData } = await importRefreshTodayData();

        await expect(refreshTodayData('site-1')).resolves.toMatchObject({ status: 'error', errorMessage: 'tesla down' });
        expect(siteRepoMock.releaseImportLock).toHaveBeenCalledWith('site-1', expect.any(String));
    });
});

describe('refreshTodayData latch', () => {
    // 10:00 CDT on 2026-10-24; Chicago midnight is 05:00Z.
    const latest = new Date('2026-10-24T15:00:00Z');

    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        vi.unstubAllEnvs();
        delete (globalThis as unknown as { __todayRefreshState?: Map<string, unknown> }).__todayRefreshState;
        userRepoMock.getTokensForSite.mockResolvedValue(tokens);
        siteRepoMock.acquireImportLock.mockResolvedValue(true);
        siteRepoMock.releaseImportLock.mockResolvedValue(true);
        siteRepoMock.getImportStatus.mockResolvedValue({ isImporting: false, lastImportAt: 0 });
        siteRepoMock.getSite.mockResolvedValue({ id: 'site-1', timezone: 'America/Chicago' });
        createEnergyRepoMock.mockReturnValue(energyRepoMock);
        teslaTokenRepoMock.getLockedRefreshHandler.mockReturnValue(tokenRefreshHandlers);
        energyRepoMock.getLatestEnergyData.mockResolvedValue({ timestamp: latest });
        importerMock.refreshTodayRecords.mockResolvedValue({ rows: [], rowsPersisted: 0 });
        vi.useFakeTimers({ toFake: ['Date'] });
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllEnvs();
    });

    const refresh = async (now: string, options = {}) => {
        vi.setSystemTime(new Date(now));
        const { refreshTodayData } = await import('./today-refresh');
        return refreshTodayData('site-1', options);
    };

    it('skips Tesla, tokens and the import lock until the next sample is due', async () => {
        await expect(refresh('2026-10-24T15:06:59Z')).resolves.toEqual({ status: 'not-due' });
        expect(userRepoMock.getTokensForSite).not.toHaveBeenCalled();
        expect(siteRepoMock.acquireImportLock).not.toHaveBeenCalled();
        expect(importerMock.refreshTodayRecords).not.toHaveBeenCalled();
    });

    it('fetches once the next sample is due (label + 5 min + publish lag)', async () => {
        await refresh('2026-10-24T15:07:00Z');
        expect(importerMock.refreshTodayRecords).toHaveBeenCalledWith('site-1', latest);
    });

    it('fetches when nothing is stored yet', async () => {
        energyRepoMock.getLatestEnergyData.mockResolvedValue(null);
        await refresh('2026-10-24T15:01:00Z');
        expect(importerMock.refreshTodayRecords).toHaveBeenCalledWith('site-1', null);
    });

    it('lets force callers bypass the latch', async () => {
        await refresh('2026-10-24T15:01:00Z', { force: true });
        expect(importerMock.refreshTodayRecords).toHaveBeenCalledOnce();
    });

    it('still fetches yesterday\'s last samples across midnight', async () => {
        // Stored up to 23:50 CDT: the 23:55 sample is due 00:02, after midnight.
        const lastEvening = new Date('2026-10-25T04:50:00Z');
        energyRepoMock.getLatestEnergyData.mockResolvedValue({ timestamp: lastEvening });
        await expect(refresh('2026-10-25T04:56:59Z')).resolves.toEqual({ status: 'not-due' });
        await refresh('2026-10-25T05:00:30Z');
        expect(importerMock.refreshTodayRecords).toHaveBeenCalledWith('site-1', lastEvening);
    });

    it('waits for today\'s first sample once yesterday is fully stored', async () => {
        energyRepoMock.getLatestEnergyData.mockResolvedValue({ timestamp: new Date('2026-10-25T04:55:00Z') });
        await expect(refresh('2026-10-25T05:01:59Z')).resolves.toEqual({ status: 'not-due' });
        await refresh('2026-10-25T05:02:00Z');
        expect(importerMock.refreshTodayRecords).toHaveBeenCalledOnce();
    });

    it('writes day records and reports the samples persisted', async () => {
        const rows = [{ timestamp: new Date('2026-10-24T15:05:00Z') }];
        importerMock.refreshTodayRecords.mockResolvedValue({ rows, rowsPersisted: 126 });
        await expect(refresh('2026-10-24T15:07:00Z')).resolves.toEqual({ status: 'persisted', rowsPersisted: 126 });
        expect(importerMock.refreshTodayRecords).toHaveBeenCalledWith('site-1', latest);
    });

    it('reports no new rows when Tesla had nothing newer', async () => {
        importerMock.refreshTodayRecords.mockResolvedValue({ rows: [{ timestamp: latest }], rowsPersisted: 121 });
        await expect(refresh('2026-10-24T15:07:00Z')).resolves.toEqual({ status: 'no-new-rows' });
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

    it('keeps the stored reading on a transient failure so routes degrade instead of failing', async () => {
        const { TeslaRefreshBackoffError } = await import('./tesla-refresh-outcome');
        const staleAt = Date.now() - 17 * 60 * 1000; // past the 16-min TTL
        siteRepoMock.getSite.mockResolvedValue({ id: 'site-1', live_status_cache: { percentage_charged: 61 }, last_live_refresh_at: staleAt });
        teslaClientMock.getLiveStatus.mockRejectedValue(new TeslaRefreshBackoffError(Date.now() + 60_000));
        const { refreshLiveStatus } = await importRefreshLiveStatus();

        await expect(refreshLiveStatus('site-1')).resolves.toMatchObject({
            status: 'error', liveStatus: { percentage_charged: 61 }, fetchedAt: staleAt,
        });
    });

    it.each([
        ['an inactive account', { is_active: false }],
        ['no refresh grant', { refresh_token: null }],
    ])('does not present a fresh cache as healthy for %s', async (_label, connection) => {
        siteRepoMock.getSite.mockResolvedValue({ id: 'site-1', live_status_cache: { percentage_charged: 61 }, last_live_refresh_at: Date.now() });
        userRepoMock.getTokensForSite.mockResolvedValue({ ...tokens, ...connection });
        const { refreshLiveStatus } = await importRefreshLiveStatus();
        await expect(refreshLiveStatus('site-1')).resolves.toMatchObject({ status: 'connection-required' });
    });

    it.each(['reconnect_required', 'uncertain'])('does not present a fresh cache as healthy when the account is %s', async state => {
        siteRepoMock.getSite.mockResolvedValue({
            id: 'site-1',
            live_status_cache: { percentage_charged: 61 },
            last_live_refresh_at: Date.now(),
        });
        userRepoMock.getTokensForSite.mockResolvedValue({ ...tokens, tesla_refresh_state: state });
        const { refreshLiveStatus } = await importRefreshLiveStatus();

        // Routes answer 409 (clients keep the reconnect prompt); stored data
        // is still attached for callers that render it.
        await expect(refreshLiveStatus('site-1')).resolves.toEqual({
            status: 'connection-required',
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

    it('cancels the Tesla request when the live deadline expires', async () => {
        vi.useFakeTimers();
        try {
            siteRepoMock.getSite.mockResolvedValue({
                id: 'site-1',
                live_status_cache: null,
                last_live_refresh_at: null,
            });
            userRepoMock.getTokensForSite.mockResolvedValue(tokens);
            const { refreshLiveStatus } = await importRefreshLiveStatus();
            const { ioSignal } = await import('./io-deadline');
            let signal: AbortSignal | undefined;
            teslaClientMock.getLiveStatus.mockImplementationOnce(() => new Promise((_resolve, reject) => {
                signal = ioSignal();
                signal?.addEventListener('abort', () => reject(signal?.reason), { once: true });
            }));

            const pending = refreshLiveStatus('site-1', { timeoutMs: 100 });
            await vi.advanceTimersByTimeAsync(100);

            await expect(pending).resolves.toMatchObject({
                status: 'error',
                errorMessage: 'tesla_live_timeout',
            });
            expect(signal).toBeInstanceOf(AbortSignal);
            expect(signal?.aborted).toBe(true);
            expect(siteRepoMock.updateLiveStatusCache).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
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

    it('falls back to the stale cache when another request is already in flight', async () => {
        const staleAt = Date.now() - 17 * 60 * 1000; // older than the 16-min TTL
        siteRepoMock.getSite.mockResolvedValue({
            id: 'site-1',
            live_status_cache: { percentage_charged: 55 },
            last_live_refresh_at: staleAt,
        });

        let resolveTokens: (val: typeof tokens) => void;
        userRepoMock.getTokensForSite.mockReturnValueOnce(new Promise((resolve) => {
            resolveTokens = resolve;
        }));

        const { refreshLiveStatus } = await importRefreshLiveStatus();

        // First call: cache is stale, so it proceeds to refresh and blocks on token lookup
        const firstPromise = refreshLiveStatus('site-1');

        // Second call arrives while the first is in flight: must serve the stale
        // cache instead of returning a liveStatus-less 'in-flight' result
        const secondResult = await refreshLiveStatus('site-1');
        expect(secondResult).toMatchObject({
            status: 'cached',
            liveStatus: { percentage_charged: 55 },
            fetchedAt: staleAt,
        });

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

    it('foreground power refreshes with a narrow cache lookup and no tariff query', async () => {
        const { refreshLiveStatus } = await importRefreshLiveStatus();
        siteRepoMock.getLiveRefreshState.mockResolvedValue({ id: 'site-1' });
        await expect(refreshLiveStatus('site-1', { force: true, liveOnly: true }))
            .resolves.toMatchObject({ status: 'refreshed' });
        expect(siteRepoMock.getLiveRefreshState).toHaveBeenCalledWith('site-1');
        expect(siteRepoMock.getSite).not.toHaveBeenCalled();
        expect(teslaClientMock.getLiveStatus).toHaveBeenCalledTimes(1);
    });

    it('bypasses the claim when force is set', async () => {
        siteRepoMock.claimLiveRefresh.mockResolvedValue(false);
        const { refreshLiveStatus } = await importRefreshLiveStatus();

        await expect(refreshLiveStatus('site-1', { force: true })).resolves.toMatchObject({ status: 'refreshed' });
        expect(siteRepoMock.claimLiveRefresh).not.toHaveBeenCalled();
    });
});


