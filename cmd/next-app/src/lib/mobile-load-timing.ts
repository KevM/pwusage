import type { UsageData } from './energy-repo';
import type { MarginalCostBasis } from './marginal-cost';
import type { Schedule } from './schedule';

export interface MobileActiveLoadTiming {
    periodName: string;
    buyRate: number;
    sellRate: number;
    marginalCost: number | null;
    basis: MarginalCostBasis | 'unobserved';
    balanceKwh: number | null;
    energyDataThrough: string | null;
}

const NEUTRAL_BALANCE_KWH = 0.1;

/**
 * Builds the active-period slice from the live route's existing rollup and
 * per-period balance map. A period with no rows is unknown even when other
 * periods have data in this cycle.
 */
export function activeLoadTimingForMobile(
    schedule: Schedule,
    now: Date,
    priorCycle: UsageData[],
    todayByPeriod: Map<string, number>,
    energyDataThrough: Date | null
): MobileActiveLoadTiming | null {
    const active = schedule.getTariffPeriod(now);
    if (!active) return null;

    const periodName = active.schedule.name || 'Standard';
    const buyRate = finiteRate(active.schedule.buy_rate) ?? finiteRate(active.season.buy_rate);
    const sellRate = finiteRate(active.schedule.sell_rate) ?? finiteRate(active.season.sell_rate);
    if (buyRate === null || sellRate === null) return null;

    const priorForActive = priorCycle.filter((row) => (row.touName || 'Standard') === periodName);
    const hasObservation = priorForActive.length > 0 || todayByPeriod.has(periodName);

    let balanceKwh: number | null = null;
    let marginalCost: number | null = buyRate;
    let basis: MobileActiveLoadTiming['basis'] = 'unobserved';
    if (hasObservation) {
        const priorBalance = priorForActive.reduce((total, row) => total - row.gridUsage / 1000, 0);
        balanceKwh = priorBalance + (todayByPeriod.get(periodName) ?? 0);
        if (Math.abs(balanceKwh) < NEUTRAL_BALANCE_KWH) {
            basis = 'neutral';
            marginalCost = buyRate;
        } else if (balanceKwh > 0) {
            basis = 'sell';
            marginalCost = sellRate;
        } else {
            basis = 'buy';
            marginalCost = buyRate;
        }
    }

    return {
        periodName,
        buyRate,
        sellRate,
        marginalCost,
        basis,
        balanceKwh,
        energyDataThrough: energyDataThrough?.toISOString() ?? null,
    };
}

function finiteRate(value: number | null | undefined): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
