import { withIoDeadline, ioSignal, checkIoDeadline } from './io-deadline';
import { Importer } from './importer';
import { type EnergySiteLiveStatus } from './tesla-client';
import { SiteRepo } from './site-repo';
import { compactDayWritesEnabled, createEnergyRepo } from './energy-repo-factory';
import { withImportLock } from './import-lock';
import { createTeslaClientForSite } from './tesla-client-factory';
import { nextSampleDueAt } from './tesla-sample-timing';

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

export const REFRESH_MIN_INTERVAL_MS = 60 * 1000; // 1 minute: matches Tesla's 5-min data rate, leaves headroom.
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
    signal?: AbortSignal;
    minIntervalMs?: number;
    timeoutMs?: number;
    /** Fetch even when the next 5-minute sample is not due yet (see `nextSampleDueAt`). */
    force?: boolean;
}

export interface RefreshTodayResult {
    /** `not-due`: Tesla cannot have a sample newer than the latest stored one yet. */
    status: 'persisted' | 'no-new-rows' | 'not-due' | 'throttled' | 'in-flight' | 'no-tokens' | 'error';
    rowsPersisted?: number;
    errorMessage?: string;
}

export interface RefreshLiveStatusOptions {
    /** Foreground power does not need site metadata or tariff rows. */
    liveOnly?: boolean;
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
 * Fetch today's data from Tesla and persist any rows newer than what we
 * already have. Throttled per-site; safe to call from multiple places.
 * Latched to Tesla's data: at most one history fetch per new 5-minute sample,
 * once it is due after the latest stored one. The import lock still collapses
 * concurrent callers (across instances) to one fetch.
 * Never throws — returns a status describing what happened so callers can log.
 */
export async function refreshTodayData(
    siteId: string,
    options: RefreshTodayOptions = {}
): Promise<RefreshTodayResult> {
    return withIoDeadline(options.timeoutMs ?? TESLA_FETCH_TIMEOUT_MS,
        () => refreshTodayDataWithinDeadline(siteId, options), options.signal ?? ioSignal())
        .catch(error => ({ status: 'error' as const, errorMessage: error instanceof Error ? error.message : String(error) }));
}

async function refreshTodayDataWithinDeadline(siteId: string, options: RefreshTodayOptions): Promise<RefreshTodayResult> {
    checkIoDeadline();
    const state = getState(siteId);

    const minIntervalMs = options.minIntervalMs ?? REFRESH_MIN_INTERVAL_MS;

    if (state.inFlight) return { status: 'in-flight' };
    const now = Date.now();
    if (now - state.lastRefreshAt < minIntervalMs) {
        return { status: 'throttled' };
    }

    // Cached site. The latest stored sample (raw or day record) decides the latch
    // and whether yesterday's tail (after the last pre-midnight refresh) is missing.
    const siteRepo = new SiteRepo();
    const site = await siteRepo.getSite(siteId);
    if (!site) return { status: 'no-new-rows' };
    const latest = await createEnergyRepo(site.timezone).getLatestEnergyData(siteId);
    checkIoDeadline();
    // Labels are absolute, so midnight needs no special case: yesterday's 23:55
    // sample is due at 00:02 and that fetch also covers yesterday's tail.
    if (!options.force && latest && now < +nextSampleDueAt(latest.timestamp)) return { status: 'not-due' };

    const client = await createTeslaClientForSite(siteId);
    if (!client) {
        return { status: 'no-tokens' };
    }

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
                const importer = new Importer(client);
                const latestMs = latest?.timestamp?.getTime() ?? 0;

                if (compactDayWritesEnabled()) {
                    const { rows, rowsPersisted } = await importer.refreshTodayRecords(siteId, latest?.timestamp ?? null);
                    if (rowsPersisted === 0 || !rows.some(r => r.timestamp.getTime() > latestMs)) return { status: 'no-new-rows' };
                    return { status: 'persisted', rowsPersisted };
                }

                const rows = await importer.getTodayData(siteId, latest?.timestamp ?? null);

                checkIoDeadline();
                if (rows.length === 0) return { status: 'no-new-rows' };

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
        const site = options.liveOnly
            ? await siteRepo.getLiveRefreshState(siteId)
            : await siteRepo.getSite(siteId);
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
            // Serve the stale cache rather than a liveStatus-less result: multiple
            // components poll the same site concurrently and callers treat a
            // missing liveStatus as a hard failure (HTTP 500).
            if (cachedStatus && useCached) {
                return { status: 'cached', liveStatus: cachedStatus, fetchedAt };
            }
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

            // Cross-instance guard: in-process state above doesn't span
            // serverless instances, so claim the refresh via an atomic
            // conditional UPDATE before making the billable Tesla call.
            // force callers skip it — they explicitly want a fresh fetch.
            const claimMs = Date.now();
            if (options.force !== true) {
                const claimed = await siteRepo.claimLiveRefresh(siteId, claimMs, minIntervalMs);
                if (!claimed) {
                    if (cachedStatus && useCached) {
                        return { status: 'cached', liveStatus: cachedStatus, fetchedAt };
                    }
                    return { status: 'throttled' };
                }
            }

            try {
                const timeoutMs = options.timeoutMs ?? TESLA_LIVE_TIMEOUT_MS;
                const liveStatus = await withTimeout(client.getLiveStatus(siteId), timeoutMs, 'tesla_live');
                const refreshedAt = Date.now();
                state.lastLiveRefreshAt = refreshedAt;

                await siteRepo.updateLiveStatusCache(siteId, liveStatus, refreshedAt);

                return { status: 'refreshed', liveStatus, fetchedAt: refreshedAt };
            } catch (fetchError) {
                // Give the claim back so the next caller can retry immediately
                // instead of waiting out minIntervalMs on a failure.
                if (options.force !== true) {
                    await siteRepo.releaseLiveRefreshClaim(siteId, claimMs, fetchedAt ?? null);
                }
                throw fetchError;
            }
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

