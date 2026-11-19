import { refreshLiveStatus, refreshTodayData } from './today-refresh';

/** Live status is fetched again when the stored reading is older than this (as before). */
export const LIVE_PAGE_STATUS_TTL_MS = 60 * 1000;

export interface LivePageRefreshDeps {
    refreshTodayData: typeof refreshTodayData;
    refreshLiveStatus: typeof refreshLiveStatus;
}

export interface LivePageRefreshResult {
    /** New samples or a new live reading were stored: the open page should re-render. */
    changed: boolean;
    historyStatus: Awaited<ReturnType<typeof refreshTodayData>>['status'];
    liveStatus: Awaited<ReturnType<typeof refreshLiveStatus>>['status'];
}

/**
 * Fetch fresh Tesla data for the Live page after its stored snapshot is on
 * screen. Both calls keep their own locks, throttles and deadlines, so a
 * re-render after a change finds them throttled or cached and does not loop.
 */
export async function refreshLivePage(
    siteId: string,
    deps: LivePageRefreshDeps = { refreshTodayData, refreshLiveStatus }
): Promise<LivePageRefreshResult> {
    const [history, live] = await Promise.all([
        deps.refreshTodayData(siteId),
        deps.refreshLiveStatus(siteId, { cacheTtlMs: LIVE_PAGE_STATUS_TTL_MS })
            .catch(error => ({ status: 'error' as const, errorMessage: error instanceof Error ? error.message : String(error) })),
    ]);
    if (history.status === 'error') {
        console.warn(`[SiteLivePage] today refresh failed for ${siteId}: ${history.errorMessage}`);
    }
    return {
        changed: history.status === 'persisted' || live.status === 'refreshed',
        historyStatus: history.status,
        liveStatus: live.status,
    };
}
