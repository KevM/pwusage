/**
 * Client side of `/api/sync`: imports the days around the viewed date first,
 * then the rest of the billing period, and reports stored-history changes.
 *
 * The page is refreshed only from `onHistoryChanged`, which fires at most once
 * per sync request and only when the importer rewrote at least one day record
 * (`changedDays` in the stream). An already-covered period, an unchanged
 * re-fetch or a failed request with nothing written causes no refresh.
 */

export type SyncStatus = 'checking' | 'active';

export interface SyncStepResult {
    complete: boolean;
    partial: boolean;
    error: boolean;
    processedWindows?: number;
    totalWindows?: number;
    /** ISO day starts the importer rewrote during this request. */
    changedDays: string[];
}

export interface DataSyncDeps {
    siteId: string;
    fetch: typeof fetch;
    signal: AbortSignal;
    onStatus: (status: SyncStatus, message?: string) => void;
    /** A request finished (or failed); the indicator can hide. */
    onIdle: () => void;
    /** Stored history changed: refresh what shows it. Called once per request that changed something. */
    onHistoryChanged: (changedDays: string[]) => void;
    sleep?: (ms: number) => Promise<void>;
    now?: () => Date;
}

/** Retry limits shared by both stages. */
export const MAX_SYNC_ATTEMPTS = 15;
const MAX_CONSECUTIVE_IDLE = 2;

function readChangedDays(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** One `/api/sync` request, read to the end of its event stream. */
export async function runSyncStep(deps: DataSyncDeps, start: Date, end: Date): Promise<SyncStepResult> {
    const { siteId, signal, onStatus } = deps;
    const result: SyncStepResult = { complete: false, partial: false, error: false, changedDays: [] };
    onStatus('checking');
    try {
        const params = new URLSearchParams({ siteId, start: start.toISOString(), end: end.toISOString() });
        const res = await deps.fetch(`/api/sync?${params.toString()}`, { signal });
        const reader = res.ok ? res.body?.getReader() : undefined;
        if (!reader) return { ...result, error: true };

        const decoder = new TextDecoder();
        let buffer = '';
        const handleLine = (line: string) => {
            if (!line.startsWith('data: ')) return;
            let data: { status?: string; message?: string; processedWindows?: unknown; totalWindows?: unknown; changedDays?: unknown };
            try {
                data = JSON.parse(line.slice(6));
            } catch {
                return;
            }
            if (data.status === 'checking') {
                onStatus('checking');
            } else if (data.status === 'progress') {
                onStatus('active', data.message);
            } else if (data.status === 'partial') {
                result.partial = true;
                result.processedWindows = typeof data.processedWindows === 'number' ? data.processedWindows : undefined;
                result.totalWindows = typeof data.totalWindows === 'number' ? data.totalWindows : undefined;
                result.changedDays = readChangedDays(data.changedDays);
                onStatus('active', data.message || 'Importing historical data...');
            } else if (data.status === 'complete') {
                result.complete = true;
                result.changedDays = readChangedDays(data.changedDays);
            } else if (data.status === 'error') {
                result.error = true;
                result.changedDays = readChangedDays(data.changedDays);
            }
        };

        while (true) {
            const { done, value } = await reader.read();
            if (done || signal.aborted) break;
            // Events can span chunks; keep the unfinished line for the next read.
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            lines.forEach(handleLine);
        }
        if (!signal.aborted) handleLine(buffer + decoder.decode());
    } catch (err) {
        if ((err as Error).name !== 'AbortError') console.error('Info sync error:', err);
        result.error = true;
    }
    return result;
}

/** Run a request, then hide the indicator and report a change at most once. */
export async function syncAndNotify(deps: DataSyncDeps, start: Date, end: Date): Promise<SyncStepResult> {
    const result = await runSyncStep(deps, start, end);
    if (!deps.signal.aborted) {
        deps.onIdle();
        if (result.changedDays.length > 0) deps.onHistoryChanged(result.changedDays);
    }
    return result;
}

/**
 * Repeat a range while the server reports partial progress, within the retry
 * limits: stop on completion, a non-partial answer, two idle answers in a row,
 * or coverage that stops advancing.
 */
async function syncRangeUntilDone(deps: DataSyncDeps, start: Date, end: Date, label: string): Promise<boolean> {
    const sleep = deps.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
    let attempts = 0;
    let lastTotalWindows: number | undefined;
    let consecutiveIdle = 0;
    while (attempts < MAX_SYNC_ATTEMPTS && !deps.signal.aborted) {
        const res = await syncAndNotify(deps, start, end);
        if (res.complete) return true;
        if (!res.partial) return false;

        if (res.processedWindows === 0) {
            consecutiveIdle++;
            if (consecutiveIdle >= MAX_CONSECUTIVE_IDLE) return false;
            await sleep(1000);
            attempts++;
            continue;
        }
        consecutiveIdle = 0;

        if (res.totalWindows !== undefined && lastTotalWindows !== undefined && res.totalWindows >= lastTotalWindows) {
            console.warn(`[DataSyncer] Coverage stopped advancing in ${label} (windows: ${res.totalWindows}), stopping retry loop`);
            return false;
        }
        if (res.totalWindows !== undefined) lastTotalWindows = res.totalWindows;

        await sleep(500);
        attempts++;
    }
    return false;
}

/** The nearby days (viewed date ± 3 days) synced first so the chart fills in early. */
export function hotZone(viewDate: Date | undefined, now: Date): { start: Date; end: Date; center: Date } {
    const center = new Date(viewDate ?? now);
    // Midnight, so "now" moving by milliseconds does not change the range.
    center.setHours(0, 0, 0, 0);
    const start = new Date(center);
    start.setDate(start.getDate() - 3);
    const end = new Date(center);
    end.setDate(end.getDate() + 3);
    return { start, end, center };
}

/**
 * Nearby days first, then the full billing period.
 * Returns whether the full period completed (or there was nothing to sync).
 */
export async function runDataSync(deps: DataSyncDeps, range: { start: Date; end: Date; viewDate?: Date }): Promise<boolean> {
    const now = deps.now?.() ?? new Date();
    // Never request the future; allow an hour of clock skew.
    const safeNow = new Date(now.getTime() + 60 * 60 * 1000);
    const cap = (d: Date) => (d > safeNow ? safeNow : d);
    const { start: hotStart, end: hotEnd } = hotZone(range.viewDate, now);
    const cappedHotEnd = cap(hotEnd);
    const cappedEnd = cap(range.end);
    const cappedStart = cap(range.start);

    if (hotStart < cappedEnd && cappedHotEnd > cappedStart) {
        const s = hotStart < cappedStart ? cappedStart : hotStart;
        if (s < cappedHotEnd) {
            await syncRangeUntilDone(deps, s, cappedHotEnd, 'hot zone');
            if (deps.signal.aborted) return false;
        }
    }

    if (!(cappedStart < cappedEnd)) return true;
    return syncRangeUntilDone(deps, cappedStart, cappedEnd, 'full period');
}

/** Window event History listens for, since it fetches its chart on the client. */
export const HISTORY_CHANGED_EVENT = 'pwusage:history-changed';

export interface HistoryChangedDetail {
    siteId: string;
    changedDays: string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether any changed day start (a site-local midnight) can affect the chart
 * for `date` (YYYY-MM-DD). Allows a day either side, since the chart may be
 * drawn in the browser's time zone rather than the site's.
 */
export function changedDaysTouchDate(changedDays: string[], date: string): boolean {
    const noon = Date.parse(`${date}T12:00:00Z`);
    if (!Number.isFinite(noon)) return changedDays.length > 0;
    return changedDays.some(day => {
        const t = Date.parse(day);
        return Number.isFinite(t) && Math.abs(t - noon) <= 2 * DAY_MS;
    });
}
