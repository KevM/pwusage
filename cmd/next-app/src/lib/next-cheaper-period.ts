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
const MINUTE_MS = 60 * 1000;
// Tesla TOU boundaries land on 15-minute marks (from_minute/to_minute in the
// tariff JSON), so a 15-minute walk step samples every representable window
// at least once and never skips a sub-hour period.
const WALK_STEP_MS = 15 * MINUTE_MS;

export interface ScheduleTransition {
    /** Exact instant the new period starts matching (minute precision). */
    start: Date;
    schedule: TariffSchedule;
    period: TariffPeriod;
}

/**
 * Binary-search the exact minute a transition happened. Invariants: the
 * schedule matching at `beforeMs` is not `newScheduleId`, the one at
 * `afterMs` is. Schedule matching has minute granularity, so the flip lands
 * exactly on a minute boundary.
 */
function refineTransitionStart(
    schedule: Schedule,
    beforeMs: number,
    afterMs: number,
    newScheduleId: number
): Date {
    let lo = Math.floor(beforeMs / MINUTE_MS);
    let hi = Math.floor(afterMs / MINUTE_MS);
    while (hi - lo > 1) {
        const mid = lo + Math.floor((hi - lo) / 2);
        const tp = schedule.getTariffPeriod(new Date(mid * MINUTE_MS));
        if (tp?.schedule.id === newScheduleId) {
            hi = mid;
        } else {
            lo = mid;
        }
    }
    return new Date(hi * MINUTE_MS);
}

/**
 * Yield each schedule transition occurring strictly after `now`, walking in
 * 15-minute steps up to the horizon. We don't trust `tp.start` / `tp.end`
 * from Schedule.getTariffPeriod — it stamps both with the query time rather
 * than the period boundaries — so transitions are detected by comparing
 * `schedule.id` against the previous sample, then refined to the exact
 * boundary minute.
 */
export function* walkScheduleTransitions(
    schedule: Schedule,
    now: Date,
    maxHorizonHours: number
): Generator<ScheduleTransition> {
    const active = schedule.getTariffPeriod(now);
    if (!active) return;

    let prevScheduleId = active.schedule.id;
    let prevMatchedMs = now.getTime();
    const horizonMs = maxHorizonHours * HOUR_MS;
    for (let elapsed = WALK_STEP_MS; elapsed <= horizonMs; elapsed += WALK_STEP_MS) {
        const cursor = new Date(now.getTime() + elapsed);
        const tp = schedule.getTariffPeriod(cursor);
        if (!tp) continue;
        if (tp.schedule.id === prevScheduleId) {
            prevMatchedMs = cursor.getTime();
            continue;
        }
        yield {
            start: refineTransitionStart(schedule, prevMatchedMs, cursor.getTime(), tp.schedule.id),
            schedule: tp.schedule,
            period: tp
        };
        prevScheduleId = tp.schedule.id;
        prevMatchedMs = cursor.getTime();
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
    maxHorizonHours: number = 48
): CheaperPeriod | null {
    const active = schedule.getTariffPeriod(now);
    if (!active) return null;

    const marginalByKey = buildMarginalByKey(cycle);
    const activeKey = periodKey(active.schedule.name ?? 'Unknown');
    const activeMarginal = marginalByKey.get(activeKey);
    if (!activeMarginal || activeMarginal.marginalCost === null) return null;
    const activeCost = activeMarginal.marginalCost;

    for (const t of walkScheduleTransitions(schedule, now, maxHorizonHours)) {
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
    maxHorizonHours: number = 24 * 7
): Map<string, Date> {
    const result = new Map<string, Date>();
    const targetKeys = new Set<string>();
    for (const u of cycle) {
        const name = u.touName ?? 'Unknown';
        targetKeys.add(periodKey(name));
    }

    for (const t of walkScheduleTransitions(schedule, now, maxHorizonHours)) {
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
