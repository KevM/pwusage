import type { Schedule } from './schedule';
import type { UsageData } from './energy-repo';
import { computeMarginalCost, type MarginalCostBasis } from './marginal-cost';
import {
    findNextCheaperPeriod,
    findNextStartsByKey,
    formatRelativeStart,
    periodKey
} from './next-cheaper-period';

export interface LoadTimingActivePeriod {
    name: string;
    buyRate: number;
    sellRate: number;
}

export interface LoadTimingPeriod {
    name: string;
    marginalCost: number | null;
    basis: MarginalCostBasis;
    cycleNetExportKwh: number;
    isActive: boolean;
    nextStartPhrase: string | null;
}

export interface LoadTimingView {
    hasTariff: boolean;
    hasCycleData: boolean;
    activeIsCheapest: boolean;
    periods: LoadTimingPeriod[];
    nextCheaper: { name: string; marginalCost: number; phrase: string } | null;
    nextCheaperPhrase: string | null;
    nextStartPhraseByKey: Record<string, string>;
}

/**
 * Single source of truth for the "Load timing this cycle" computation.
 * Consumed by the live page and the TRMNL markup route so web and e-ink
 * never disagree. Pure: no IO, deterministic given its inputs.
 */
export function computeLoadTiming(
    schedule: Schedule,
    cycle: UsageData[],
    now: Date,
    timezone: string,
    activePeriod: LoadTimingActivePeriod | null
): LoadTimingView {
    const hasTariff = schedule.getTariffPeriod(now) !== null || cycle.length > 0;
    const hasCycleData = cycle.length > 0;

    let nextCheaper: LoadTimingView['nextCheaper'] = null;
    let nextCheaperPhrase: string | null = null;
    let nextStartPhraseByKey: Record<string, string> = {};
    let activeIsCheapest = false;

    if (activePeriod && hasCycleData) {
        const cheaper = findNextCheaperPeriod(schedule, now, cycle, timezone);
        if (cheaper) {
            const phrase = formatRelativeStart(cheaper.startsAt, now, timezone);
            nextCheaper = { name: cheaper.name, marginalCost: cheaper.marginalCost, phrase };
            nextCheaperPhrase = phrase;
        }

        const nextStarts = findNextStartsByKey(schedule, now, cycle, timezone);
        nextStartPhraseByKey = Object.fromEntries(
            Array.from(nextStarts.entries()).map(([key, start]) => [
                key,
                formatRelativeStart(start, now, timezone)
            ])
        );

        const activeEntry = cycle.find((u) =>
            (u.touName ?? 'Unknown') === activePeriod.name
            && (u.buyRate ?? 0) === activePeriod.buyRate
            && (u.sellRate ?? 0) === activePeriod.sellRate
        );
        const activeMarginal = activeEntry ? computeMarginalCost(activeEntry).marginalCost : null;
        if (activeMarginal !== null && activeEntry) {
            activeIsCheapest = cycle.every((u) => {
                if (u === activeEntry) return true;
                const m = computeMarginalCost(u).marginalCost;
                return m === null || m >= activeMarginal;
            });
        }
    }

    const periods: LoadTimingPeriod[] = cycle.map((u) => {
        const name = u.touName ?? 'Unknown';
        const { cycleNetExportKwh, marginalCost, basis } = computeMarginalCost(u);
        const isActive = activePeriod !== null
            && name === activePeriod.name
            && (u.buyRate ?? 0) === activePeriod.buyRate
            && (u.sellRate ?? 0) === activePeriod.sellRate;
        const key = periodKey(name, u.buyRate ?? 0, u.sellRate ?? 0);
        const nextStartPhrase = isActive ? null : (nextStartPhraseByKey[key] ?? null);
        return { name, marginalCost, basis, cycleNetExportKwh, isActive, nextStartPhrase };
    });

    return {
        hasTariff,
        hasCycleData,
        activeIsCheapest,
        periods,
        nextCheaper,
        nextCheaperPhrase,
        nextStartPhraseByKey
    };
}
