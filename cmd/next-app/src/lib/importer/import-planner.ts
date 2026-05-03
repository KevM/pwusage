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
    let cursor = getSiteMidnight(requestedRange.start, timezone);

    if (installationDate) {
        const installMidnight = getSiteMidnight(installationDate, timezone);
        if (cursor.getTime() < installMidnight.getTime()) {
            cursor = installMidnight;
        }
    }

    const todayStart = getSiteMidnight(now, timezone);
    let tsIndex = 0;

    while (cursor.getTime() < requestedRange.end.getTime()) {
        const windowStart = cursor.getTime();
        const nextDay = getSiteMidnight(
            new Date(windowStart + 30 * 60 * 60 * 1000),
            timezone
        );
        const windowEnd = nextDay.getTime();
        const isToday = cursor.getTime() === todayStart.getTime();

        while (tsIndex < existingTimestamps.length && existingTimestamps[tsIndex] < windowStart) {
            tsIndex++;
        }

        let firstInWindow: number | null = null;
        let lastInWindow: number | null = null;
        let count = 0;
        let tempIdx = tsIndex;
        while (tempIdx < existingTimestamps.length && existingTimestamps[tempIdx] < windowEnd) {
            if (firstInWindow === null) firstInWindow = existingTimestamps[tempIdx];
            lastInWindow = existingTimestamps[tempIdx];
            count++;
            tempIdx++;
        }

        const effectiveWindowEnd = isToday ? now : nextDay;

        results.push({
            windowStart: cursor,
            windowEnd: nextDay,
            effectiveWindowEnd,
            isToday,
            count,
            firstInWindow,
            lastInWindow,
            missingStart: firstInWindow !== null && (firstInWindow - windowStart > gapThresholdMs),
            missingEnd: lastInWindow !== null && (effectiveWindowEnd.getTime() - lastInWindow > gapThresholdMs),
        });

        cursor = nextDay;
    }

    return results;
}

export function planImport(options: PlanOptions): DateWindow[] {
    const { forceRefetch = false } = options;
    return auditDays(options)
        .filter(d => d.count === 0 || forceRefetch || d.missingStart || d.missingEnd)
        .map(d => ({ start: d.windowStart, end: d.effectiveWindowEnd }));
}

export function splitAtUtcMidnight(window: DateWindow): DateWindow[] {
    const results: DateWindow[] = [];
    let cursor = new Date(window.start);

    while (cursor < window.end) {
        // Find the start of the next UTC day
        const nextUtcDay = new Date(Date.UTC(
            cursor.getUTCFullYear(),
            cursor.getUTCMonth(),
            cursor.getUTCDate() + 1
        ));

        // Determine the actual chunk end
        const chunkEnd = nextUtcDay < window.end ? nextUtcDay : window.end;

        results.push({ start: new Date(cursor), end: new Date(chunkEnd) });

        cursor = new Date(chunkEnd);
    }

    return results;
}
