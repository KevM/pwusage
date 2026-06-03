import type { Schedule, TariffPeriod } from './schedule';
import type { TariffSchedule } from './db';
import type { UsageData } from './energy-repo';
import { computeMarginalCost, type MarginalCostResult } from './marginal-cost';

export interface CheaperPeriod {
    name: string;
    startsAt: Date;
    marginalCost: number;
    basis: 'sell' | 'buy';
}

/** Build the lookup key used to match a cycle UsageData entry to a schedule period. */
export function periodKey(name: string): string {
    return name;
}

function buildMarginalByKey(cycle: UsageData[]): Map<string, MarginalCostResult> {
    const map = new Map<string, MarginalCostResult>();
    for (const u of cycle) {
        const name = u.touName ?? 'Unknown';
        const key = periodKey(name);
        map.set(key, computeMarginalCost(u));
    }
    return map;
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * Snap a UTC instant back to the start of its enclosing wall-clock hour in
 * `timeZone`. The Schedule matcher resolves periods at hour granularity, so
 * transitions always fall on local-hour boundaries — and that's what we want
 * to show the user as the "starts at" time.
 */
function snapToLocalHourStart(cursor: Date, timeZone: string): Date {
    const parts: Record<string, string> = {};
    new Intl.DateTimeFormat('en-US', {
        timeZone, minute: '2-digit', second: '2-digit', hour12: false
    }).formatToParts(cursor).forEach((p) => { parts[p.type] = p.value; });
    const minute = parseInt(parts.minute, 10) || 0;
    const second = parseInt(parts.second, 10) || 0;
    const msIntoHour = minute * 60_000 + second * 1000 + cursor.getMilliseconds();
    return new Date(cursor.getTime() - msIntoHour);
}

export interface ScheduleTransition {
    /** Local-hour-aligned start of the new period in the site timezone. */
    start: Date;
    schedule: TariffSchedule;
    period: TariffPeriod;
}

/**
 * Yield each schedule transition occurring strictly after `now`, walking
 * wall-clock hours up to the horizon. We don't trust `tp.start` / `tp.end`
 * from Schedule.getTariffPeriod — it stamps both with the query time rather
 * than the period boundaries — so transitions are detected by comparing
 * `schedule.id` against the previous hour's match.
 */
export function* walkScheduleTransitions(
    schedule: Schedule,
    now: Date,
    timeZone: string,
    maxHorizonHours: number
): Generator<ScheduleTransition> {
    const active = schedule.getTariffPeriod(now);
    if (!active) return;

    let prevScheduleId = active.schedule.id;
    const horizonMs = maxHorizonHours * HOUR_MS;
    for (let elapsed = HOUR_MS; elapsed <= horizonMs; elapsed += HOUR_MS) {
        const cursor = new Date(now.getTime() + elapsed);
        const tp = schedule.getTariffPeriod(cursor);
        if (!tp) continue;
        if (tp.schedule.id === prevScheduleId) continue;
        yield {
            start: snapToLocalHourStart(cursor, timeZone),
            schedule: tp.schedule,
            period: tp
        };
        prevScheduleId = tp.schedule.id;
    }
}

/**
 * Walk the schedule forward from `now` until we find a period whose current
 * marginal cost is strictly lower than the currently-active period's marginal
 * cost. Caps the search at `maxHorizonHours`.
 *
 * Returns null if:
 *  - there's no active period at `now` (gap in the schedule)
 *  - the active period has no resolvable marginal cost (e.g. neutral basis)
 *  - no cheaper period found within the horizon
 */
export function findNextCheaperPeriod(
    schedule: Schedule,
    now: Date,
    cycle: UsageData[],
    timeZone: string,
    maxHorizonHours: number = 48
): CheaperPeriod | null {
    const active = schedule.getTariffPeriod(now);
    if (!active) return null;

    const marginalByKey = buildMarginalByKey(cycle);
    const activeKey = periodKey(active.schedule.name ?? 'Unknown');
    const activeMarginal = marginalByKey.get(activeKey);
    if (!activeMarginal || activeMarginal.marginalCost === null) return null;
    const activeCost = activeMarginal.marginalCost;

    for (const t of walkScheduleTransitions(schedule, now, timeZone, maxHorizonHours)) {
        const key = periodKey(t.schedule.name ?? 'Unknown');
        const marginal = marginalByKey.get(key);
        if (marginal && marginal.marginalCost !== null) {
            // Future marginal cost based on the transition's own rates
            const buyRate = t.schedule.buy_rate ?? 0;
            const sellRate = t.schedule.sell_rate ?? 0;
            const transitionCost = marginal.basis === 'sell' ? sellRate : buyRate;

            if (transitionCost < activeCost) {
                return {
                    name: t.schedule.name ?? 'Unknown',
                    startsAt: t.start,
                    marginalCost: transitionCost,
                    basis: (marginal.basis === 'neutral' ? 'buy' : marginal.basis) as 'sell' | 'buy'
                };
            }
        }
    }
    return null;
}

/**
 * For each period in `cycle` (keyed by name), find the
 * earliest future start within the horizon. The active period's current
 * occurrence is not recorded — callers asking "when does this period next
 * occur?" don't want the in-progress start.
 */
export function findNextStartsByKey(
    schedule: Schedule,
    now: Date,
    cycle: UsageData[],
    timeZone: string,
    maxHorizonHours: number = 24 * 7
): Map<string, Date> {
    const result = new Map<string, Date>();
    const targetKeys = new Set<string>();
    for (const u of cycle) {
        const name = u.touName ?? 'Unknown';
        targetKeys.add(periodKey(name));
    }

    for (const t of walkScheduleTransitions(schedule, now, timeZone, maxHorizonHours)) {
        const key = periodKey(t.schedule.name ?? 'Unknown');
        if (targetKeys.has(key) && !result.has(key)) {
            result.set(key, t.start);
        }
    }
    return result;
}

/**
 * Format a future Date as a human-friendly relative phrase in the site's
 * timezone. Examples (en-US):
 *   "today at 8 PM"
 *   "tomorrow at 6 AM"
 *   "Friday at 8 AM"  (within a week)
 *   "Mar 25 at 8 AM"  (further out)
 */
export function formatRelativeStart(start: Date, now: Date, timeZone: string): string {
    const dayKey = (d: Date) =>
        new Intl.DateTimeFormat('en-US', {
            timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
        }).format(d);

    const startKey = dayKey(start);
    const nowKey = dayKey(now);

    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const tomorrowKey = dayKey(tomorrow);

    const time = new Intl.DateTimeFormat('en-US', {
        timeZone, hour: 'numeric', minute: '2-digit', hour12: true
    }).format(start)
        .replace(':00', ''); // "8 PM" instead of "8:00 PM"

    if (startKey === nowKey) return `today at ${time}`;
    if (startKey === tomorrowKey) return `tomorrow at ${time}`;

    const daysOut = Math.round((start.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
    if (daysOut < 7) {
        const weekday = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long' }).format(start);
        return `${weekday} at ${time}`;
    }

    const date = new Intl.DateTimeFormat('en-US', {
        timeZone, month: 'short', day: 'numeric'
    }).format(start);
    return `${date} at ${time}`;
}
