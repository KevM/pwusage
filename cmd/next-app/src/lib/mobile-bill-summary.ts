import type { UsageData } from './energy-repo';
import { wattsToKilowatts } from './energy-utils';
import { computeLoadTiming, type LoadTimingActivePeriod, type LoadTimingView } from './load-timing';
import { buildLoadTimingTimeline, type LoadTimingTimelineSegment } from './load-timing-timeline';
import type { MobileBillPeriod } from './mobile-dashboard-contract';
import type { Schedule } from './schedule';

/**
 * The tariff timeline is consumed only for forward planning from the balance
 * snapshot. The iOS estimator accepts a balance up to 60 minutes old for its
 * forecast-free (history or flat) card, and 30 minutes with a solar forecast,
 * so the timeline must reach back an hour. A site that last reported months
 * ago would otherwise make this request resolve tariffs across the entire gap
 * between its final sample and now. Clamp the start to that usable window.
 */
const TIMELINE_LOOKBACK_MS = 60 * 60 * 1000;

export interface MobileLoadTimingWithTimeline extends LoadTimingView {
    tariffTimeline: LoadTimingTimelineSegment[];
}

/**
 * Group TOU usage rows by `(tariffName, periodName)`, matching the web bill's
 * grouping across seasonal rates and rate plan versions while preserving
 * canonical netted costs.
 */
export function summarizeBillUsage(usage: UsageData[]): {
    estimatedCost: number | null;
    periods: MobileBillPeriod[];
} {
    const estimatedCost = usage.length > 0
        ? usage.reduce((sum, item) => sum + (item.cost ?? 0), 0)
        : null;
    const periodGroups = new Map<string, MobileBillPeriod>();
    for (const item of usage) {
        const tariffName = item.tariff?.name || 'Unknown';
        const periodName = item.touName || 'Unknown';
        const key = JSON.stringify([tariffName, periodName]);
        let period = periodGroups.get(key);
        if (!period) {
            period = { tariffName, periodName, netGridKwh: 0, cost: 0 };
            periodGroups.set(key, period);
        }
        period.netGridKwh += wattsToKilowatts(item.gridUsage);
        period.cost += item.cost ?? 0;
    }
    return {
        estimatedCost,
        periods: Array.from(periodGroups.values()),
    };
}

/**
 * Resolve the active TOU period at `now` if all periods in its season have
 * finite buy and sell rates.
 */
export function resolveActiveLoadTimingPeriod(
    schedule: Schedule,
    now: Date
): LoadTimingActivePeriod | null {
    const active = schedule.getTariffPeriod(now);
    const buyRate = active ? active.schedule.buy_rate ?? active.season.buy_rate : null;
    const sellRate = active ? active.schedule.sell_rate ?? active.season.sell_rate : null;
    const hasResolvableSeasonRates = active !== null && (active.season.schedules ?? []).every((period) =>
        Number.isFinite(period.buy_rate ?? active.season.buy_rate)
        && Number.isFinite(period.sell_rate ?? active.season.sell_rate)
    );
    const hasResolvableActiveRates = hasResolvableSeasonRates
        && typeof buyRate === 'number' && Number.isFinite(buyRate)
        && typeof sellRate === 'number' && Number.isFinite(sellRate);
    return active && hasResolvableActiveRates
        ? { name: active.schedule.name || 'Standard', buyRate, sellRate }
        : null;
}

/**
 * Build the mobile `loadTiming` payload (including `tariffTimeline`) from
 * resolved cycle usage and schedule.
 */
export function buildMobileLoadTiming(params: {
    schedule: Schedule;
    usage: UsageData[];
    now: Date;
    timezone: string;
    cycleEnd: Date;
    energyDataThrough: Date | null;
    hasTariffs: boolean;
    hasRevision?: boolean;
}): MobileLoadTimingWithTimeline | null {
    const {
        schedule,
        usage,
        now,
        timezone,
        cycleEnd,
        energyDataThrough,
        hasTariffs,
        hasRevision = false,
    } = params;
    const activePeriod = resolveActiveLoadTimingPeriod(schedule, now);
    const loadTiming = hasTariffs && activePeriod
        ? computeLoadTiming(schedule, usage, now, timezone, activePeriod)
        : null;
    if (!loadTiming) return null;

    const timelineStart = new Date(Math.max(
        energyDataThrough ? Math.min(energyDataThrough.getTime(), now.getTime()) : now.getTime(),
        now.getTime() - TIMELINE_LOOKBACK_MS,
    ));
    const sevenDaysOut = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const outlookHorizon = sevenDaysOut.getTime() + (hasRevision ? 60 * 60 * 1000 : 0);
    return {
        ...loadTiming,
        tariffTimeline: buildLoadTimingTimeline(
            schedule,
            timelineStart,
            new Date(Math.max(outlookHorizon, cycleEnd.getTime())),
            sevenDaysOut
        ),
    };
}
