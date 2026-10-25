import { formatSiteDate, getSiteMidnight } from '../date-utils';
import type { DailyCoverageStat } from '../energy-repo';
import { DAY_GAP_HEAL_DAYS } from '../prototypes/day-attribution';

export interface DateWindow {
    start: Date;
    end: Date;
}

export interface PlanOptions {
    requestedRange: DateWindow;
    existingCoverage: DailyCoverageStat[];
    timezone: string;
    installationDate?: Date;
    forceRefetch?: boolean;
    /**
     * Day writes on: refetch every `open` day record but today's (the today
     * refresh owns it), however small its gaps; `complete` and `gapped`
     * records are settled and never refetched automatically.
     */
    refetchOpenDays?: boolean;
    gapThresholdMs?: number;
    now?: Date;
}

export interface DayAuditResult extends DayWindow {
    count: number;
    firstInWindow: number | null;
    lastInWindow: number | null;
    missingStart: boolean;
    missingEnd: boolean;
    hasInteriorGap: boolean;
    /** A settled archive day: covered unless the caller forces a re-fetch. */
    archived: boolean;
    /** An `open` v2 day record (see `DailyCoverageStat.open`). */
    open: boolean;
}

export interface GenerateDayWindowsOptions {
    requestedRange: DateWindow;
    timezone: string;
    installationDate?: Date;
    now?: Date;
}

/**
 * One site-local day of the audit range, as produced by `generateDayWindows`.
 * Distinct from `DateWindow` above, which is a plain `{ start, end }` span used
 * to describe ranges handed to and returned from `planImport`.
 */
export interface DayWindow {
    windowStart: Date;
    windowEnd: Date;
    effectiveWindowEnd: Date;
    isToday: boolean;
}

export function generateDayWindows(options: GenerateDayWindowsOptions): DayWindow[] {
    const { requestedRange, timezone, installationDate, now = new Date() } = options;

    const windows: DayWindow[] = [];
    let cursor = getSiteMidnight(requestedRange.start, timezone);

    if (installationDate) {
        const installMidnight = getSiteMidnight(installationDate, timezone);
        if (cursor.getTime() < installMidnight.getTime()) {
            cursor = installMidnight;
        }
    }

    // Clamp the end of our audit range to the current time to avoid importing the future.
    const auditEnd = requestedRange.end.getTime() > now.getTime() ? now : requestedRange.end;
    const todayStart = getSiteMidnight(now, timezone);

    while (cursor.getTime() < auditEnd.getTime()) {
        const windowStart = cursor.getTime();
        const nextDay = getSiteMidnight(
            new Date(windowStart + 30 * 60 * 60 * 1000),
            timezone
        );
        const isToday = cursor.getTime() === todayStart.getTime();
        const effectiveWindowEnd = isToday && nextDay.getTime() > now.getTime() ? now : nextDay;

        windows.push({
            windowStart: cursor,
            windowEnd: nextDay,
            effectiveWindowEnd,
            isToday,
        });

        cursor = nextDay;
    }

    return windows;
}

export function auditDays(options: PlanOptions): DayAuditResult[] {
    const {
        requestedRange,
        existingCoverage,
        timezone,
        installationDate,
        gapThresholdMs = 30 * 60 * 1000,
        now = new Date(),
    } = options;

    const coverageByDay = new Map<string, DailyCoverageStat>(
        existingCoverage.map(stat => [stat.localDayKey, stat])
    );

    const results: DayAuditResult[] = [];

    for (const day of generateDayWindows({ requestedRange, timezone, installationDate, now })) {
        // `generateDayWindows` emits exactly one window per site-local day, so
        // the window start's local date identifies the day the SQL aggregate
        // grouped by. A day with no stored samples has no entry at all.
        const key = formatSiteDate(day.windowStart, timezone);
        const stat = coverageByDay.get(key) ?? {
            localDayKey: key,
            count: 0,
            first: null,
            last: null,
            maxInteriorGapMs: 0,
        };
        // A record's status is computed when written, so an open day that has aged
        // past the gap-heal window counts as gapped (settled), as a rewrite would store it.
        const aged = stat.open === true && now.getTime() - day.windowEnd.getTime() > DAY_GAP_HEAL_DAYS * 24 * 3600000;
        const firstInWindow = stat.first === null ? null : stat.first.getTime();
        const lastInWindow = stat.last === null ? null : stat.last.getTime();

        results.push({
            windowStart: day.windowStart,
            windowEnd: day.windowEnd,
            effectiveWindowEnd: day.effectiveWindowEnd,
            isToday: day.isToday,
            count: stat.count,
            firstInWindow,
            lastInWindow,
            missingStart: firstInWindow !== null && (firstInWindow - day.windowStart.getTime() > gapThresholdMs),
            missingEnd: lastInWindow !== null && (day.effectiveWindowEnd.getTime() - lastInWindow > gapThresholdMs),
            hasInteriorGap: stat.maxInteriorGapMs > gapThresholdMs,
            archived: stat.archived === true || aged,
            open: stat.open === true && !aged,
        });
    }

    return results;
}

/**
 * `openRetry`: planned only because it is an open record (its gaps are under
 * the thresholds). Tesla often returns the same gaps, so a window cap serves
 * other days first or these retries would take the cap every run.
 */
export interface PlannedWindow extends DateWindow {
    openRetry?: true;
}

export function planImport(options: PlanOptions): PlannedWindow[] {
    const { forceRefetch = false, refetchOpenDays = false } = options;
    return auditDays(options).flatMap(d => {
        const window = { start: d.windowStart, end: d.effectiveWindowEnd };
        if (forceRefetch) return [window];
        // Re-fetching a settled archive day rewrites its raw rows, which drops the
        // archive (and restores a trimmed day): a churn loop for days Tesla can't fill.
        if (d.archived) return [];
        if (d.count === 0 || d.missingStart || d.missingEnd || d.hasInteriorGap) return [window];
        return refetchOpenDays && d.open && !d.isToday ? [{ ...window, openRetry: true as const }] : [];
    });
}

export function splitAtSiteMidnight(window: DateWindow, timezone: string): DateWindow[] {
    const results: DateWindow[] = [];
    let cursor = new Date(window.start);

    while (cursor < window.end) {
        // Find current day's midnight in site's timezone
        const currentMidnight = getSiteMidnight(cursor, timezone);

        // Find the start of the next day in the site's timezone by adding 30 hours to the current midnight
        // (adding 30h to midnight is DST-safe and always lands in the next day)
        let nextDayMidnight = getSiteMidnight(new Date(currentMidnight.getTime() + 30 * 60 * 60 * 1000), timezone);

        // Fallback safety to avoid infinite loops if date math behaves weirdly
        if (nextDayMidnight <= cursor) {
            nextDayMidnight = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
        }

        // Determine the actual chunk end
        const chunkEnd = nextDayMidnight < window.end ? nextDayMidnight : window.end;

        results.push({ start: new Date(cursor), end: new Date(chunkEnd) });

        cursor = new Date(chunkEnd);
    }

    return results;
}
