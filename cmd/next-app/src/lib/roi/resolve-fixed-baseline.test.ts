import { describe, it, expect } from 'vitest';
import { pickCurrentFixedBaseline } from './resolve-fixed-baseline';
import type { ComparisonPlan } from './comparison-tariff-repo';

describe('pickCurrentFixedBaseline', () => {
    it('returns the current version of the (latest) plan as RoiInputs', () => {
        const plans: ComparisonPlan[] = [{
            name: 'PG&E flat',
            versions: [
                { version: 2, is_current: true, effective_from: '2026-01-01', buy_rate: 0.19342, sell_rate: 0.08 },
                { version: 1, is_current: false, effective_from: '2024-01-01', buy_rate: 0.16580, sell_rate: 0.08 },
            ],
        }];
        expect(pickCurrentFixedBaseline(plans)).toEqual({ fixedBuyRate: 0.19342, fixedSellRate: 0.08 });
    });

    it('returns null when there is no comparison plan', () => {
        expect(pickCurrentFixedBaseline([])).toBeNull();
    });
});
