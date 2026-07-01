import { Importer } from './importer';
import { TeslaClient } from './tesla-client';
import { TeslaTokenRepo } from './tesla-token-repo';
import { SiteRepo } from './site-repo';
import { EnergyRepo } from './energy-repo';
import { UserRepo } from './user-repo';

/**
 * Per-site throttle state. Both the live page (server render + poll) and the
 * Trmnl markup endpoint go through this module, so the same site can only be
 * refreshed once per MIN_INTERVAL_MS no matter how many callers ask.
 *
 * Backed by globalThis so HMR in dev doesn't reset the state between hot
 * reloads of this module.
 */
interface RefreshState {
    inFlight: boolean;
    lastRefreshAt: number;
}

const REFRESH_MIN_INTERVAL_MS = 60 * 1000; // 1 minute: matches Tesla's 5-min data rate, leaves headroom.
const TESLA_FETCH_TIMEOUT_MS = 8 * 1000;   // bound the await so the page never hangs on a slow Tesla.

function getStateMap(): Map<string, RefreshState> {
    return ((globalThis as unknown as { __todayRefreshState?: Map<string, RefreshState> }).__todayRefreshState
        ??= new Map<string, RefreshState>());
}

function getState(siteId: string): RefreshState {
    const map = getStateMap();
    let state = map.get(siteId);
    if (!state) {
        state = { inFlight: false, lastRefreshAt: 0 };
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

export interface RefreshTodayResult {
    status: 'persisted' | 'no-new-rows' | 'throttled' | 'in-flight' | 'no-tokens' | 'error';
    rowsPersisted?: number;
    errorMessage?: string;
}

/**
 * Fetch today's data from Tesla and persist any rows newer than what we
 * already have. Throttled per-site; safe to call from multiple places.
 * Never throws — returns a status describing what happened so callers can log.
 */
export async function refreshTodayData(siteId: string): Promise<RefreshTodayResult> {
    const state = getState(siteId);

    if (state.inFlight) return { status: 'in-flight' };
    const now = Date.now();
    if (now - state.lastRefreshAt < REFRESH_MIN_INTERVAL_MS) {
        return { status: 'throttled' };
    }

    const tokens = await new UserRepo().getTokensForSite(siteId);
    if (!tokens?.access_token || !tokens?.refresh_token) {
        return { status: 'no-tokens' };
    }

    const siteRepo = new SiteRepo();
    const lockId = crypto.randomUUID();
    const acquired = await siteRepo.acquireImportLock({
        siteId,
        lockId,
        lockDurationMs: 60000,
        minIntervalMs: REFRESH_MIN_INTERVAL_MS
    });

    if (!acquired) {
        const status = await siteRepo.getImportStatus(siteId);
        if (status.isImporting) {
            return { status: 'in-flight' };
        }
        return { status: 'throttled' };
    }

    state.inFlight = true;
    state.lastRefreshAt = Date.now();

    try {
        const energyRepo = new EnergyRepo();
        const tokenRepo = new TeslaTokenRepo(siteRepo);
        const handlers = tokenRepo.getLockedRefreshHandler(siteId);

        const client = new TeslaClient({
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token,
            tokenRefreshHandler: handlers.refreshHandler,
            onTokenError: handlers.errorHandler,
            onTokenUpdate: () => {}
        });

        const importer = new Importer(client);

        const [latest, rows] = await Promise.all([
            energyRepo.getLatestEnergyData(siteId),
            withTimeout(importer.getTodayData(siteId), TESLA_FETCH_TIMEOUT_MS, 'tesla_today')
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
        try {
            await siteRepo.releaseImportLock(siteId, lockId);
        } catch (err) {
            console.error(`[TodayRefresh] Failed to release DB import lock for site ${siteId}:`, err);
        }
    }
}
