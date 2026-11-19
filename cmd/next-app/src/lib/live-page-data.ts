import { readLiveBillingAvailability } from './billing-availability';
import type { EnergyData } from './db';
import { sumTodayRows, type EnergyRepo, type LatestEnergySnapshot, type TodayTotals, type UsageData } from './energy-repo';
import type { EnergySiteLiveStatus } from './tesla-client';

/**
 * A stored live reading older than this is not shown as current power or
 * charge; the latest stored history sample is used instead. Matches the
 * live-status cache lifetime (`LIVE_STATUS_CACHE_TTL_MS` in today-refresh).
 */
export const STORED_LIVE_MAX_AGE_MS = 16 * 60 * 1000;

export type LiveTodayRepo = Pick<EnergyRepo, 'getRawEnergyData' | 'getCycleAndTodayTotals' | 'getUsageByTOU' | 'getBucketedEnergyData'>;

export interface LiveTodayHistory {
    billing: Awaited<ReturnType<typeof readLiveBillingAvailability<UsageData>>>;
    todayRows: EnergyData[];
    todayChartRows: EnergyData[];
    todayTotals: TodayTotals;
}

/**
 * Today's history for the Live page from one decoded read of today's samples,
 * shared by billing (and its today-only fallback), the chart and the totals.
 */
export async function readLiveTodayHistory(
    repo: LiveTodayRepo, siteId: string, cycleStart: Date, todayStart: Date, now: Date
): Promise<LiveTodayHistory> {
    const todayRows = await repo.getRawEnergyData(siteId, todayStart, now);
    const shared = { start: todayStart, rows: todayRows };
    const [billing, todayChartRows] = await Promise.all([
        readLiveBillingAvailability(
            () => repo.getCycleAndTodayTotals(siteId, cycleStart, todayStart, now, shared),
            () => repo.getUsageByTOU(siteId, todayStart, now, todayRows)
        ),
        repo.getBucketedEnergyData(siteId, todayStart, now, todayRows),
    ]);
    return { billing, todayRows, todayChartRows, todayTotals: sumTodayRows(todayRows) };
}

export interface StoredSiteLiveState {
    live_status_cache?: unknown | null;
    last_live_refresh_at?: number | string;
}

export interface StoredLiveReading {
    liveStatus: EnergySiteLiveStatus | null;
    /** When the shown reading was taken; null when nothing is stored. */
    asOf: Date | null;
}

function cachedLiveStatus(site: StoredSiteLiveState): { status: EnergySiteLiveStatus; at: Date } | null {
    const cache = site.live_status_cache;
    if (!cache || typeof cache !== 'object') return null;
    const status = cache as EnergySiteLiveStatus;
    const fromStatus = typeof status.timestamp === 'string' ? Date.parse(status.timestamp) : NaN;
    const fetched = Number(site.last_live_refresh_at);
    const at = Number.isFinite(fromStatus) ? fromStatus : Number.isFinite(fetched) && fetched > 0 ? fetched : NaN;
    return Number.isFinite(at) ? { status, at: new Date(at) } : null;
}

/**
 * The reading the Live page renders before Tesla answers: the stored live
 * status when it is recent, otherwise none (the page falls back to the latest
 * stored history sample, as it did when Tesla failed). Never calls Tesla.
 */
export function storedLiveReading(site: StoredSiteLiveState, latest: LatestEnergySnapshot | null, now: Date): StoredLiveReading {
    const cached = cachedLiveStatus(site);
    if (cached && +now - +cached.at <= STORED_LIVE_MAX_AGE_MS && +cached.at <= +now + 60_000) {
        return { liveStatus: cached.status, asOf: cached.at };
    }
    return { liveStatus: null, asOf: latest?.timestamp ?? null };
}
