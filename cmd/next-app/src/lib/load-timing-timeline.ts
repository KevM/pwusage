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

/** Build a compact tariff timeline by sampling local tariff rules at UTC minute boundaries. */
export function buildLoadTimingTimeline(
    schedule: Schedule,
    now: Date,
    horizonEnd: Date
): LoadTimingTimelineSegment[] {
    const startMs = now.getTime();
    const endMs = horizonEnd.getTime();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return [];

    const first = resolvePeriod(schedule, new Date(startMs));
    if (!first) return [];

    const segments: LoadTimingTimelineSegment[] = [];
    let segmentStart = startMs;
    let current = first;
    let sampleAt = Math.floor(startMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS;

    while (sampleAt < endMs) {
        const resolved = resolvePeriod(schedule, new Date(sampleAt));
        if (!resolved) return [];
        if (!samePeriod(current, resolved)) {
            segments.push(toSegment(segmentStart, sampleAt, current));
            segmentStart = sampleAt;
            current = resolved;
        }
        sampleAt += MINUTE_MS;
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
