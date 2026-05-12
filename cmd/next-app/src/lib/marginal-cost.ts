import type { UsageData } from './energy-repo';
import { wattsToKilowatts } from './energy-utils';

export type MarginalCostBasis = 'sell' | 'buy' | 'neutral';

export interface MarginalCostResult {
    cycleNetExportKwh: number;
    marginalCost: number | null;
    basis: MarginalCostBasis;
}

const DEFAULT_EPSILON_KWH = 0.1;

export function computeMarginalCost(
    usage: UsageData,
    epsilonKwh: number = DEFAULT_EPSILON_KWH
): MarginalCostResult {
    // UsageData.gridUsage is positive when importing, negative when exporting
    // (see EnergyRepo cost calc). Negate to get an export-positive value.
    const cycleNetExportKwh = -wattsToKilowatts(usage.gridUsage);
    const buyRate = usage.buyRate ?? 0;
    const sellRate = usage.sellRate ?? 0;

    if (Math.abs(cycleNetExportKwh) < epsilonKwh) {
        return { cycleNetExportKwh, marginalCost: buyRate, basis: 'neutral' };
    }
    if (cycleNetExportKwh > 0) {
        return { cycleNetExportKwh, marginalCost: sellRate, basis: 'sell' };
    }
    return { cycleNetExportKwh, marginalCost: buyRate, basis: 'buy' };
}
