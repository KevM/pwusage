import { getSiteMidnight } from '../date-utils';

export interface DateWindow {
    start: Date;
    end: Date;
}

export interface PlanOptions {
    requestedRange: DateWindow;
    existingTimestamps: number[];
    timezone: string;
    installationDate?: Date;
    forceRefetch?: boolean;
    gapThresholdMs?: number;
    now?: Date;
}

export interface DayAuditResult {
    windowStart: Date;
    windowEnd: Date;
    effectiveWindowEnd: Date;
    isToday: boolean;
    count: number;
    firstInWindow: number | null;
    lastInWindow: number | null;
    missingStart: boolean;
    missingEnd: boolean;
    hasInteriorGap: boolean;
}

export interface GenerateDayWindowsOptions {
    requestedRange: DateWindow;
    timezone: string;
    installationDate?: Date;
    now?: Date;
}

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
        existingTimestamps,
        timezone,
        installationDate,
        gapThresholdMs = 30 * 60 * 1000,
        now = new Date(),
    } = options;

    const results: DayAuditResult[] = [];
    let tsIndex = 0;

    for (const day of generateDayWindows({ requestedRange, timezone, installationDate, now })) {
        const windowStart = day.windowStart.getTime();
        const windowEnd = day.windowEnd.getTime();
        const effectiveWindowEnd = day.effectiveWindowEnd;

        while (tsIndex < existingTimestamps.length && existingTimestamps[tsIndex] < windowStart) {
            tsIndex++;
        }

        let firstInWindow: number | null = null;
        let lastInWindow: number | null = null;
        let count = 0;
        let tempIdx = tsIndex;
        let hasInteriorGap = false;
        let lastTs: number | null = null;

        while (tempIdx < existingTimestamps.length && existingTimestamps[tempIdx] < windowEnd) {
            const currentTs = existingTimestamps[tempIdx];
            if (firstInWindow === null) firstInWindow = currentTs;
            if (lastTs !== null && (currentTs - lastTs > gapThresholdMs)) {
                hasInteriorGap = true;
            }
            lastTs = currentTs;
            lastInWindow = currentTs;
            count++;
            tempIdx++;
        }

        results.push({
            windowStart: day.windowStart,
            windowEnd: day.windowEnd,
            effectiveWindowEnd,
            isToday: day.isToday,
            count,
            firstInWindow,
            lastInWindow,
            missingStart: firstInWindow !== null && (firstInWindow - windowStart > gapThresholdMs),
            missingEnd: lastInWindow !== null && (effectiveWindowEnd.getTime() - lastInWindow > gapThresholdMs),
            hasInteriorGap,
        });
    }

    return results;
}

export function planImport(options: PlanOptions): DateWindow[] {
    const { forceRefetch = false } = options;
    return auditDays(options)
        .filter(d => d.count === 0 || forceRefetch || d.missingStart || d.missingEnd || d.hasInteriorGap)
        .map(d => ({ start: d.windowStart, end: d.effectiveWindowEnd }));
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
