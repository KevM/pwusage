import { Importer } from './importer';
import { TeslaClient, type EnergySiteLiveStatus } from './tesla-client';
import { TeslaTokenRepo } from './tesla-token-repo';
import { SiteRepo } from './site-repo';
import { EnergyRepo } from './energy-repo';
import { UserRepo } from './user-repo';
import { withImportLock } from './import-lock';

/**
 * Per-site throttle state. Demand-driven refresh triggers go through this
 * module, so the same site can only be refreshed once per MIN_INTERVAL_MS no
 * matter how many callers ask.
 *
 * Backed by globalThis so HMR in dev doesn't reset the state between hot
 * reloads of this module.
 */
interface RefreshState {
    inFlight: boolean;
    lastRefreshAt: number;
    liveInFlight: boolean;
    lastLiveRefreshAt: number;
}

const REFRESH_MIN_INTERVAL_MS = 60 * 1000; // 1 minute: matches Tesla's 5-min data rate, leaves headroom.
const TESLA_FETCH_TIMEOUT_MS = 8 * 1000;   // bound the await so the page never hangs on a slow Tesla.
const LIVE_STATUS_CACHE_TTL_MS = 16 * 60 * 1000;
const LIVE_STATUS_REFRESH_MIN_INTERVAL_MS = 14 * 60 * 1000;
const TESLA_LIVE_TIMEOUT_MS = 3000;

function getStateMap(): Map<string, RefreshState> {
    return ((globalThis as unknown as { __todayRefreshState?: Map<string, RefreshState> }).__todayRefreshState
        ??= new Map<string, RefreshState>());
}

function getState(siteId: string): RefreshState {
    const map = getStateMap();
    let state = map.get(siteId);
    if (!state) {
        state = { inFlight: false, lastRefreshAt: 0, liveInFlight: false, lastLiveRefreshAt: 0 };
        map.set(siteId, state);
    }
    return state;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`${label}_timeout`)), ms);
        promise.then((v) => { clearTimeout(t); resolve(v); },
            (e) => { clearTimeout(t); reject(e); });
    });
}

export interface RefreshTodayOptions {
    minIntervalMs?: number;
    timeoutMs?: number;
}

export interface RefreshTodayResult {
    status: 'persisted' | 'no-new-rows' | 'throttled' | 'in-flight' | 'no-tokens' | 'error';
    rowsPersisted?: number;
    errorMessage?: string;
}

export interface RefreshLiveStatusOptions {
    cacheTtlMs?: number;
    minIntervalMs?: number;
    timeoutMs?: number;
    force?: boolean;
    useCached?: boolean;
}

export interface RefreshLiveStatusResult {
    status: 'refreshed' | 'cached' | 'in-flight' | 'throttled' | 'no-tokens' | 'site-not-found' | 'error';
    liveStatus?: EnergySiteLiveStatus;
    fetchedAt?: number;
    errorMessage?: string;
}

function readLiveStatus(value: unknown): EnergySiteLiveStatus | undefined {
    if (value && typeof value === 'object') {
        return value as EnergySiteLiveStatus;
    }
    return undefined;
}

function readFetchedAt(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === 'string') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
}

/**
 * Shared factory to construct a TeslaClient wired to locked token refresh handlers.
 */
/**
 * Shared factory to construct a TeslaClient wired to locked token refresh handlers.
 * Allows creation if refresh_token exists (using 'expired' fallback if access_token is missing/null)
 * so that callers can trigger token refresh on 401 and self-recover.
 */
export async function createTeslaClientForSite(siteId: string): Promise<TeslaClient | null> {
    const tokens = await new UserRepo().getTokensForSite(siteId);
    if (!tokens?.refresh_token) {
        return null;
    }
    const siteRepo = new SiteRepo();
    const tokenRepo = new TeslaTokenRepo(siteRepo);
    const handlers = tokenRepo.getLockedRefreshHandler(siteId);
    return new TeslaClient({
        accessToken: tokens.access_token || 'expired',
        refreshToken: tokens.refresh_token,
        tokenRefreshHandler: handlers.refreshHandler,
        onTokenError: handlers.errorHandler,
        onTokenUpdate: () => {}
    });
}

/**
 * Fetch today's data from Tesla and persist any rows newer than what we
 * already have. Throttled per-site; safe to call from multiple places.
 * Never throws — returns a status describing what happened so callers can log.
 */
export async function refreshTodayData(
    siteId: string,
    options: RefreshTodayOptions = {}
): Promise<RefreshTodayResult> {
    const state = getState(siteId);

    const minIntervalMs = options.minIntervalMs ?? REFRESH_MIN_INTERVAL_MS;
    const timeoutMs = options.timeoutMs ?? TESLA_FETCH_TIMEOUT_MS;

    if (state.inFlight) return { status: 'in-flight' };
    const now = Date.now();
    if (now - state.lastRefreshAt < minIntervalMs) {
        return { status: 'throttled' };
    }

    const client = await createTeslaClientForSite(siteId);
    if (!client) {
        return { status: 'no-tokens' };
    }

    const siteRepo = new SiteRepo();
    const lockResult = await withImportLock<RefreshTodayResult>(
        siteRepo,
        {
            siteId,
            lockDurationMs: 60000,
            minIntervalMs,
            logLabel: 'TodayRefresh',
        },
        async (): Promise<RefreshTodayResult> => {
            state.inFlight = true;
            state.lastRefreshAt = Date.now();

            try {
                const energyRepo = new EnergyRepo();
                const importer = new Importer(client);

                const [latest, rows] = await Promise.all([
                    energyRepo.getLatestEnergyData(siteId),
                    withTimeout(importer.getTodayData(siteId), timeoutMs, 'tesla_today')
                ]);

                if (rows.length === 0) return { status: 'no-new-rows' };

                const latestMs = latest?.timestamp?.getTime() ?? 0;
                const hasNewRows = rows.some((r) => r.timestamp.getTime() > latestMs);

                // Problem 5: Drop strict pre-filter and let persistHistory do the job.
                const rowsPersisted = await importer.persistHistory(siteId, rows, latest?.timestamp ?? null);
                if (rowsPersisted === 0) return { status: 'no-new-rows' };

                if (!hasNewRows) {
                    return { status: 'no-new-rows' };
                }

                return { status: 'persisted', rowsPersisted };
            } catch (error) {
                return {
                    status: 'error',
                    errorMessage: error instanceof Error ? error.message : String(error)
                };
            } finally {
                state.inFlight = false;
            }
        }
    );

    if (lockResult.status === 'not-acquired') {
        const status = await siteRepo.getImportStatus(siteId);
        if (status.isImporting) {
            return { status: 'in-flight' };
        }
        return { status: 'throttled' };
    }

    return lockResult.value;
}

export async function refreshLiveStatus(
    siteId: string,
    options: RefreshLiveStatusOptions = {}
): Promise<RefreshLiveStatusResult> {
    const siteRepo = new SiteRepo();

    try {
        const site = await siteRepo.getSite(siteId);
        if (!site) {
            return { status: 'site-not-found' };
        }

        const now = Date.now();
        const cacheTtlMs = options.cacheTtlMs ?? LIVE_STATUS_CACHE_TTL_MS;
        const minIntervalMs = options.minIntervalMs ?? options.cacheTtlMs ?? LIVE_STATUS_REFRESH_MIN_INTERVAL_MS;
        const cachedStatus = readLiveStatus(site.live_status_cache);
        const fetchedAt = readFetchedAt(site.last_live_refresh_at);
        const useCached = options.useCached ?? true;

        if (useCached && options.force !== true && cachedStatus && fetchedAt && now - fetchedAt < cacheTtlMs) {
            return { status: 'cached', liveStatus: cachedStatus, fetchedAt };
        }

        const state = getState(siteId);
        if (state.liveInFlight) {
            return { status: 'in-flight' };
        }

        if (
            options.force !== true
            && state.lastLiveRefreshAt > 0
            && now - state.lastLiveRefreshAt < minIntervalMs
        ) {
            if (cachedStatus && useCached) {
                return { status: 'cached', liveStatus: cachedStatus, fetchedAt };
            }
            return { status: 'throttled' };
        }

        state.liveInFlight = true;

        try {
            const client = await createTeslaClientForSite(siteId);
            if (!client) {
                return { status: 'no-tokens' };
            }

            const timeoutMs = options.timeoutMs ?? TESLA_LIVE_TIMEOUT_MS;
            const liveStatus = await withTimeout(client.getLiveStatus(siteId), timeoutMs, 'tesla_live');
            const refreshedAt = Date.now();
            state.lastLiveRefreshAt = refreshedAt;

            await siteRepo.updateLiveStatusCache(siteId, liveStatus, refreshedAt);

            return { status: 'refreshed', liveStatus, fetchedAt: refreshedAt };
        } finally {
            state.liveInFlight = false;
        }
    } catch (error) {
        return {
            status: 'error',
            errorMessage: error instanceof Error ? error.message : String(error)
        };
    }
}

