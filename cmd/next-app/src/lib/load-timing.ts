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
    buyRate: number;
    sellRate: number;
}

export interface LoadTimingView {
    hasTariff: boolean;
    hasCycleData: boolean;
    activeIsCheapest: boolean;
    periods: LoadTimingPeriod[];
    /**
     * Every TOU period of the current season, including ones this cycle has
     * not reached yet (zero banked surplus, configured rates). `periods` stays
     * limited to what the cycle actually recorded, so the cards and the TRMNL
     * screen are unaffected; only the "can I run this now?" comparison needs
     * the full set.
     */
    pricingPeriods: LoadTimingPeriod[];
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

    // Group/merge cycle entries by TOU name to support crossing seasons cleanly
    const groupedCycleMap = new Map<string, UsageData>();
    for (const u of cycle) {
        const name = u.touName ?? 'Unknown';
        let group = groupedCycleMap.get(name);
        if (!group) {
            group = {
                start: u.start,
                homeUsage: 0,
                gridUsage: 0,
                solarProduction: 0,
                batteryChange: 0,
                tariff: u.tariff,
                touName: name,
                buyRate: u.buyRate,
                sellRate: u.sellRate
            };
            groupedCycleMap.set(name, group);
        }
        group.homeUsage += u.homeUsage;
        group.gridUsage += u.gridUsage;
        group.solarProduction += u.solarProduction;
        group.batteryChange += u.batteryChange;
    }

    // Resolve current active rates to apply to grouped cycle data
    const active = schedule.getTariffPeriod(now);
    const currentRates = new Map<string, { buyRate: number; sellRate: number }>();
    if (active && active.season && active.season.schedules) {
        for (const s of active.season.schedules) {
            const name = s.name || 'Standard';
            if (!currentRates.has(name)) {
                currentRates.set(name, {
                    buyRate: s.buy_rate ?? active.season.buy_rate ?? 0,
                    sellRate: s.sell_rate ?? active.season.sell_rate ?? 0
                });
            }
        }
    }

    // Update grouped cycle entries with the current season's active rates if available
    for (const [name, group] of groupedCycleMap.entries()) {
        const rates = currentRates.get(name);
        if (rates) {
            group.buyRate = rates.buyRate;
            group.sellRate = rates.sellRate;
        }
    }

    // Convert back to array
    let groupedCycle = Array.from(groupedCycleMap.values());

    // Filter to only include periods in the current active season's schedules if active season is resolved
    if (active && active.season && active.season.schedules) {
        const activeNames = new Set(active.season.schedules.map(s => s.name || 'Standard'));
        groupedCycle = groupedCycle.filter(u => activeNames.has(u.touName || 'Standard'));
    }

    // Periods the affordance widget prices against: the observed ones plus any
    // current-season period the cycle has yet to reach. Without this, a widget
    // opened before the first on-peak window of a cycle cannot show what the
    // load would cost on-peak — which is the comparison it exists to make.
    const pricingCycle: UsageData[] = [...groupedCycle];
    if (active && active.season && active.season.schedules) {
        const seen = new Set(groupedCycle.map(u => u.touName || 'Standard'));
        for (const [name, rates] of currentRates.entries()) {
            if (seen.has(name)) continue;
            pricingCycle.push({
                start: now,
                homeUsage: 0,
                gridUsage: 0,
                solarProduction: 0,
                batteryChange: 0,
                tariff: active.tariff,
                touName: name,
                buyRate: rates.buyRate,
                sellRate: rates.sellRate
            });
        }
    }

    let nextCheaper: LoadTimingView['nextCheaper'] = null;
    let nextCheaperPhrase: string | null = null;
    let nextStartPhraseByKey: Record<string, string> = {};
    let activeIsCheapest = false;

    if (activePeriod && hasCycleData) {
        const cheaper = findNextCheaperPeriod(schedule, now, groupedCycle, timezone);
        if (cheaper) {
            const phrase = formatRelativeStart(cheaper.startsAt, now, timezone);
            nextCheaper = { name: cheaper.name, marginalCost: cheaper.marginalCost, phrase };
            nextCheaperPhrase = phrase;
        }

        const nextStarts = findNextStartsByKey(schedule, now, pricingCycle, timezone);
        nextStartPhraseByKey = Object.fromEntries(
            Array.from(nextStarts.entries()).map(([key, start]) => [
                key,
                formatRelativeStart(start, now, timezone)
            ])
        );

        const activeEntry = groupedCycle.find((u) =>
            (u.touName ?? 'Unknown') === activePeriod.name
        );
        const activeMarginal = activeEntry ? computeMarginalCost(activeEntry).marginalCost : null;
        if (activeMarginal !== null && activeEntry) {
            activeIsCheapest = groupedCycle.every((u) => {
                if (u === activeEntry) return true;
                const m = computeMarginalCost(u).marginalCost;
                return m === null || m >= activeMarginal;
            });
        }
    }

    const toPeriod = (u: UsageData): LoadTimingPeriod => {
        const name = u.touName ?? 'Unknown';
        const { cycleNetExportKwh, marginalCost, basis } = computeMarginalCost(u);
        const isActive = activePeriod !== null
            && name === activePeriod.name;
        const key = periodKey(name);
        const nextStartPhrase = isActive ? null : (nextStartPhraseByKey[key] ?? null);
        return {
            name, marginalCost, basis, cycleNetExportKwh, isActive, nextStartPhrase,
            buyRate: u.buyRate ?? 0,
            sellRate: u.sellRate ?? 0
        };
    };

    const periods: LoadTimingPeriod[] = groupedCycle.map(toPeriod);
    const pricingPeriods: LoadTimingPeriod[] = pricingCycle.map(toPeriod);

    return {
        hasTariff,
        hasCycleData,
        activeIsCheapest,
        periods,
        pricingPeriods,
        nextCheaper,
        nextCheaperPhrase,
        nextStartPhraseByKey
    };
}
