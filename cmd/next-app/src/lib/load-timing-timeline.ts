import { Temporal } from '@js-temporal/polyfill';
import type { Schedule } from './schedule';
import { periodKey } from './next-cheaper-period';

export interface LoadTimingTimelineSegment {
    start: string;
    end: string;
    periodKey: string;
    name: string;
    buyRate: number;
    sellRate: number;
}

interface ResolvedPeriod {
    scheduleId: number;
    periodKey: string;
    name: string;
    buyRate: number;
    sellRate: number;
}

/**
 * Instants in (startMs, endMs) where the tariff could switch: every schedule
 * window edge and midnight on each local day (both occurrences of a repeated
 * fall-back time), plus every zone transition. Between two consecutive
 * instants the local date and the minute-of-day window are fixed, so the
 * resolved period is too.
 */
function candidateInstants(schedule: Schedule, startMs: number, endMs: number): number[] {
    const timeZone = schedule.siteTimeZone;
    const minutes = schedule.boundaryMinutes();
    const instants = new Set<number>();
    const add = (ms: number) => { if (ms > startMs && ms < endMs) instants.add(ms); };
    const startZoned = Temporal.Instant.fromEpochMilliseconds(startMs).toZonedDateTimeISO(timeZone);
    const lastDate = Temporal.Instant.fromEpochMilliseconds(endMs).toZonedDateTimeISO(timeZone).toPlainDate();
    for (let date = startZoned.toPlainDate(); Temporal.PlainDate.compare(date, lastDate) <= 0; date = date.add({ days: 1 })) {
        for (const minute of minutes) {
            const local = date.toPlainDateTime({ hour: Math.floor(minute / 60), minute: minute % 60 });
            add(local.toZonedDateTime(timeZone, { disambiguation: 'earlier' }).epochMilliseconds);
            add(local.toZonedDateTime(timeZone, { disambiguation: 'later' }).epochMilliseconds);
        }
    }
    for (let transition = startZoned.getTimeZoneTransition('next');
        transition && transition.epochMilliseconds < endMs;
        transition = transition.getTimeZoneTransition('next')) {
        add(transition.epochMilliseconds);
    }
    return [...instants].sort((a, b) => a - b);
}

/**
 * Build a compact tariff timeline by resolving the tariff at every instant
 * its rules could switch. A tariff gap before `requiredEnd` yields no
 * timeline; a gap after it ends the timeline there (the app treats that as
 * the end of coverage).
 */
export function buildLoadTimingTimeline(
    schedule: Schedule,
    now: Date,
    horizonEnd: Date,
    requiredEnd: Date = horizonEnd
): LoadTimingTimelineSegment[] {
    const startMs = now.getTime();
    const endMs = horizonEnd.getTime();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return [];

    const first = resolvePeriod(schedule, new Date(startMs));
    if (!first) return [];

    const segments: LoadTimingTimelineSegment[] = [];
    let segmentStart = startMs;
    let current = first;
    for (const at of candidateInstants(schedule, startMs, endMs)) {
        const resolved = resolvePeriod(schedule, new Date(at));
        if (resolved && samePeriod(current, resolved)) continue;
        segments.push(toSegment(segmentStart, at, current));
        if (!resolved) return at >= requiredEnd.getTime() ? segments : [];
        segmentStart = at;
        current = resolved;
    }

    segments.push(toSegment(segmentStart, endMs, current));
    return segments;
}

function resolvePeriod(schedule: Schedule, at: Date): ResolvedPeriod | null {
    const match = schedule.getTariffPeriod(at);
    if (!match) return null;
    const buyRate = match.schedule.buy_rate ?? match.season.buy_rate;
    const sellRate = match.schedule.sell_rate ?? match.season.sell_rate;
    if (!Number.isFinite(buyRate) || !Number.isFinite(sellRate)) return null;
    return {
        scheduleId: match.schedule.id,
        periodKey: periodKey(match.schedule.name || 'Standard'),
        name: match.schedule.name || 'Standard',
        buyRate,
        sellRate,
    };
}

function samePeriod(a: ResolvedPeriod, b: ResolvedPeriod): boolean {
    return a.scheduleId === b.scheduleId && a.buyRate === b.buyRate && a.sellRate === b.sellRate;
}

function toSegment(start: number, end: number, period: ResolvedPeriod): LoadTimingTimelineSegment {
    return {
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
        periodKey: period.periodKey,
        name: period.name,
        buyRate: period.buyRate,
        sellRate: period.sellRate,
    };
}
