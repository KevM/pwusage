import type { RoiInputs } from './roi-service';
import { ComparisonTariffRepo, type ComparisonPlan } from './comparison-tariff-repo';

/** Pure: pick the current version of the most-recent Fixed comparison plan.
 *  v1 prices the matrix Fixed column from a single baseline; if multiple plans
 *  exist, the one with the most-recent current effective_from wins. */
export function pickCurrentFixedBaseline(plans: ComparisonPlan[]): RoiInputs | null {
    let best: { eff: string; v: ComparisonPlan['versions'][number] } | null = null;
    for (const plan of plans) {
        const current = plan.versions.find(v => v.is_current && v.kind === 'fixed');
        if (!current) continue;
        const eff = current.effective_from ?? '0000-01-01';
        if (!best || eff > best.eff) best = { eff, v: current };
    }
    if (!best) return null;
    return { fixedBuyRate: best.v.buy_rate, fixedSellRate: best.v.sell_rate };
}

export async function resolveFixedBaseline(siteId: string): Promise<RoiInputs | null> {
    const plans = await new ComparisonTariffRepo().listFixedComparisons(siteId);
    return pickCurrentFixedBaseline(plans);
}
