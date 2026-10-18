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

const MINUTE_MS = 60_000;
/**
 * Tariff rules switch on whole local minutes, and in practice on quarter
 * hours. Walk in quarter-hour steps and, when the period differs, bisect the
 * minutes in between so an off-quarter switch still lands on its minute.
 */
const STEP_MS = 15 * MINUTE_MS;

/**
 * Build a compact tariff timeline by sampling local tariff rules at UTC minute
 * boundaries. A tariff gap before `requiredEnd` yields no timeline; a gap after
 * it ends the timeline there (the app treats that as the end of coverage).
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
    let current: ResolvedPeriod = first;
    // The latest minute known to resolve to `current`.
    let knownAt = startMs;
    let sampleAt = Math.floor(startMs / STEP_MS) * STEP_MS + STEP_MS;

    while (knownAt < endMs) {
        const probeAt = Math.min(sampleAt, endMs);
        const probe = probeAt < endMs ? resolvePeriod(schedule, new Date(probeAt)) : current;
        if (probe && samePeriod(current, probe)) {
            knownAt = probeAt;
            sampleAt += STEP_MS;
            continue;
        }
        // The period changes (or coverage ends) somewhere in (knownAt, probeAt]:
        // find the first whole minute that differs.
        let low = Math.floor(knownAt / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
        let high = probeAt;
        while (low < high) {
            const middle = Math.floor((low + high) / 2 / MINUTE_MS) * MINUTE_MS;
            const resolved = resolvePeriod(schedule, new Date(middle));
            if (resolved && samePeriod(current, resolved)) low = middle + MINUTE_MS;
            else high = middle;
        }
        const changeAt = low;
        const next = resolvePeriod(schedule, new Date(changeAt));
        segments.push(toSegment(segmentStart, changeAt, current));
        if (!next) return changeAt >= requiredEnd.getTime() ? segments : [];
        segmentStart = changeAt;
        current = next;
        knownAt = changeAt;
        if (sampleAt <= changeAt) sampleAt = Math.floor(changeAt / STEP_MS) * STEP_MS + STEP_MS;
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
