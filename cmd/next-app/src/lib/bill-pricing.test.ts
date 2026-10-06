import { describe, expect, it } from 'vitest';
import { priceBillUsage } from './bill-pricing';

function row(gridUsage: number, buyRate = 0.3, sellRate = 0.04) {
    return { tariff: { name: 'Utility' }, touName: 'Peak', gridUsage, buyRate, sellRate, cost: 999 };
}

describe('bill pricing across multiple historical rate buckets', () => {
    it('distributes export offsets proportionally across remaining imports at historical rates', () => {
        const usage = [row(10000, 0.2), row(20000, 0.4), row(-15000)];
        priceBillUsage(usage);
        // 15 of the 30 imported kWh remain: 5 at 20¢ + 10 at 40¢.
        expect(usage.map(r => r.cost)).toEqual([1, 4, 0]);
        expect(usage.map(r => r.gridUsage)).toEqual([10000, 20000, -15000]);
    });
    it('distributes import offsets proportionally across exports with different sell rates', () => {
        const usage = [row(-10000, 0.3, 0.04), row(-20000, 0.3, 0.1), row(15000)];
        priceBillUsage(usage);
        expect(usage.map(r => r.cost)).toEqual([-0.2, -1, 0]);
    });
    it('gives the same prices regardless of input order and is safe to repeat', () => {
        const usage = [row(-10000), row(20000, 0.4), row(10000, 0.2)];
        priceBillUsage(usage);
        const costs = usage.map(r => r.cost);
        usage.reverse();
        priceBillUsage(usage);
        expect(usage.map(r => r.cost)).toEqual(costs.reverse());
    });
    it('does not round small energy balances before calculating the bill', () => {
        const usage = [row(-0.2), row(0.1, 0.31)];
        priceBillUsage(usage);
        expect(usage.reduce((sum, r) => sum + r.cost, 0)).toBeCloseTo(-0.000004, 12);
    });
    it('preserves the existing credit convention for a negative configured sell rate', () => {
        const usage = [row(-1000, 0.3, -0.04)];
        priceBillUsage(usage);
        expect(usage[0].cost).toBe(-0.04);
    });
});
