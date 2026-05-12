import { describe, expect, it } from 'vitest';
import { computeMarginalCost } from './marginal-cost';
import type { UsageData } from './energy-repo';

function fixture(overrides: Partial<UsageData>): UsageData {
    return {
        start: new Date(2026, 2, 1),
        homeUsage: 0,
        gridUsage: 0,
        solarProduction: 0,
        batteryChange: 0,
        // Tariff is required by the type but unused by computeMarginalCost.
        // Cast through unknown to avoid pulling in db types here.
        tariff: { id: 1, site_id: 's', updated: new Date(), name: 'On-Peak' } as unknown as UsageData['tariff'],
        buyRate: 0.30,
        sellRate: 0.03,
        ...overrides
    };
}

describe('computeMarginalCost', () => {
    it('returns sell basis when cycle is net exporting (gridUsage negative = export)', () => {
        // gridUsage = -290000 → wattsToKilowatts → -290 kWh → cycleNetExportKwh = +290 kWh
        const result = computeMarginalCost(fixture({ gridUsage: -290_000 }));
        expect(result.basis).toBe('sell');
        expect(result.marginalCost).toBeCloseTo(0.03);
        expect(result.cycleNetExportKwh).toBeCloseTo(290);
    });

    it('returns buy basis when cycle is net importing (gridUsage positive = import)', () => {
        // gridUsage = 95000 → wattsToKilowatts → 95 kWh → cycleNetExportKwh = -95 kWh
        const result = computeMarginalCost(fixture({ gridUsage: 95_000 }));
        expect(result.basis).toBe('buy');
        expect(result.marginalCost).toBeCloseTo(0.30);
        expect(result.cycleNetExportKwh).toBeCloseTo(-95);
    });

    it('returns neutral within epsilon of zero', () => {
        // gridUsage = 50 → 0.05 kWh → |0.05| < 0.1 (new default epsilon) → neutral
        const result = computeMarginalCost(fixture({ gridUsage: 50 }));
        expect(result.basis).toBe('neutral');
        expect(result.marginalCost).toBeCloseTo(0.30); // fallback to buyRate
    });

    it('treats |cycleNetExport| exactly equal to epsilon as non-neutral', () => {
        // gridUsage = -500 → exactly -0.5 kWh → cycleNetExport = +0.5; |0.5| < 0.5 is false → sell
        const result = computeMarginalCost(fixture({ gridUsage: -500 }), 0.5);
        expect(result.basis).toBe('sell');
    });

    it('treats |cycleNetExport| just below epsilon as neutral', () => {
        // gridUsage = -499 → -0.499 kWh → cycleNetExport = +0.499 < 0.5 → neutral
        const result = computeMarginalCost(fixture({ gridUsage: -499 }), 0.5);
        expect(result.basis).toBe('neutral');
        expect(result.marginalCost).toBeCloseTo(0.30);
    });

    it('falls back to 0 for missing rates', () => {
        const result = computeMarginalCost(fixture({ gridUsage: -100_000, sellRate: undefined }));
        expect(result.basis).toBe('sell');
        expect(result.marginalCost).toBe(0);
    });

    it('honors a custom epsilon', () => {
        // gridUsage = -2000 → -2 kWh → cycleNetExport = +2; with epsilon=5 → neutral
        const result = computeMarginalCost(fixture({ gridUsage: -2_000 }), 5);
        expect(result.basis).toBe('neutral');
        expect(result.marginalCost).toBeCloseTo(0.30);
    });
});
