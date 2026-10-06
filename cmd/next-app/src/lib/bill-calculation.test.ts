import { describe, expect, it } from 'vitest';
import { calculate } from './test-support/bill-fixture';

describe('cycle-wide bill netting across seasonal rates', () => {
    it('credits Harrison’s 9.228 kWh surplus instead of charging $4.56', () => {
        const { usage, trmnl } = calculate([-27.471, 18.243]);
        expect(usage.reduce((sum, row) => sum + row.gridUsage, 0) / 1000).toBeCloseTo(-9.228);
        expect(usage.reduce((sum, row) => sum + (row.cost ?? 0), 0)).toBeCloseTo(-0.36912);
        expect(trmnl.totalBillCost).toBeCloseTo(-0.36912);
        expect(trmnl.tariffGroups[0].periods[0].cost).toBeCloseTo(-0.36912);
    });
    it('charges only the remaining winter deficit after the summer surplus offsets it', () => {
        const { usage, trmnl } = calculate([-10, 15]);
        expect(usage.reduce((sum, row) => sum + (row.cost ?? 0), 0)).toBeCloseTo(1.55);
        expect(trmnl.totalBillCost).toBeCloseTo(1.55);
    });
    it('charges zero when seasonal balances cancel exactly', () => {
        const { usage, trmnl } = calculate([-10, 10]);
        expect(usage.reduce((sum, row) => sum + (row.cost ?? 0), 0)).toBe(0);
        expect(trmnl.totalBillCost).toBe(0);
    });
});


describe('bill pricing fundamentals', () => {
    it.each([
        { label: 'all imports retain their seasonal buy rates', balances: [10, 20], buy: [0.3, 0.31], sell: [0.04, 0.04], expected: 9.2 },
        { label: 'all exports retain their seasonal sell rates', balances: [-10, -20], buy: [0.3, 0.31], sell: [0.04, 0.05], expected: -1.4 },
        { label: 'same-rate imports and exports cancel before pricing', balances: [-10, 15], buy: [0.3, 0.3], sell: [0.04, 0.04], expected: 1.5 },
        { label: 'same-rate surplus receives only the sell rate', balances: [-15, 10], buy: [0.3, 0.3], sell: [0.04, 0.04], expected: -0.2 },
        { label: 'zero energy costs zero', balances: [0, 0], buy: [0.3, 0.31], sell: [0.04, 0.04], expected: 0 },
        { label: 'zero buy rate is free', balances: [10, 20], buy: [0, 0], sell: [0.04, 0.04], expected: 0 },
        { label: 'negative buy rates retain their signed price', balances: [10, 20], buy: [-0.1, -0.2], sell: [0.04, 0.04], expected: -5 },
        { label: 'zero sell rate gives no credit', balances: [-10, -20], buy: [0.3, 0.31], sell: [0, 0], expected: 0 },
    ])('$label', ({ balances, buy, sell, expected }) => {
        const { usage, trmnl } = calculate(balances, buy, sell);
        expect(usage.reduce((sum, row) => sum + (row.cost ?? 0), 0)).toBeCloseTo(expected, 8);
        expect(trmnl.totalBillCost).toBeCloseTo(expected, 8);
    });
});

describe('bill pricing isolation and historical rates', () => {
    it.each([
        { label: 'prior-day surplus offsets today’s raw winter usage', options: { today: true }, expected: -0.36912 },
        { label: 'the same tariff name nets across append-only versions', options: { versions: true }, expected: -0.36912 },
        { label: 'different tariff names do not offset each other', options: { tariffNames: ['Old utility', 'New utility'] }, expected: 4.55649 },
        { label: 'different TOU periods do not offset each other', options: { periods: ['OFF_PEAK', 'ON_PEAK'] }, expected: 4.55649 },
    ])('$label', ({ options, expected }) => {
        const { usage, trmnl } = calculate([-27.471, 18.243], [0.3, 0.31], [0.04, 0.04], options);
        expect(usage.reduce((sum, row) => sum + (row.cost ?? 0), 0)).toBeCloseTo(expected, 8);
        expect(trmnl.totalBillCost).toBeCloseTo(expected, 8);
    });

    it('prices a remaining summer deficit at its historical buy rate after winter exports offset it', () => {
        const { usage, trmnl } = calculate([15, -10]);
        expect(usage.reduce((sum, row) => sum + (row.cost ?? 0), 0)).toBeCloseTo(1.5, 8);
        expect(trmnl.totalBillCost).toBeCloseTo(1.5, 8);
    });
    it('prices a remaining winter surplus at its own sell rate', () => {
        const { usage, trmnl } = calculate([10, -15], [0.3, 0.31], [0.04, 0.05]);
        expect(usage.reduce((sum, row) => sum + (row.cost ?? 0), 0)).toBeCloseTo(-0.25, 8);
        expect(trmnl.totalBillCost).toBeCloseTo(-0.25, 8);
    });
    it('returns no bill periods for an empty window', () => {
        const { usage, trmnl } = calculate([]);
        expect(usage).toEqual([]);
        expect(trmnl.tariffGroups).toEqual([]);
        expect(trmnl.totalBillCost).toBe(0);
    });
});

it('does not merge tariff/period names containing the grouping separator', () => {
    const { usage, trmnl } = calculate([-10, 15], [0.3, 0.3], [0.04, 0.04], {
        tariffNames: ['Utility|Peak', 'Utility'], periods: ['Night', 'Peak|Night'],
    });
    expect(usage).toHaveLength(2);
    expect(usage.reduce((sum, row) => sum + (row.cost ?? 0), 0)).toBeCloseTo(4.1, 8);
    expect(trmnl.totalBillCost).toBeCloseTo(4.1, 8);
});


it.each([false, true])('inherits season rates for missing schedule overrides (today=%s)', (today) => {
    const { usage, trmnl } = calculate([-27.471, 18.243], [null, null], [null, null], { inheritRates: true, today });
    expect(usage.reduce((sum, row) => sum + (row.cost ?? 0), 0)).toBeCloseTo(-0.36912, 8);
    expect(trmnl.totalBillCost).toBeCloseTo(-0.36912, 8);
});

it.each([false, true])('keeps a zero override instead of inheriting a nonzero season rate (today=%s)', (today) => {
    const { usage, trmnl } = calculate([10, 20], [0, 0], [null, null], { inheritRates: true, today });
    expect(usage.reduce((sum, row) => sum + (row.cost ?? 0), 0)).toBe(0);
    expect(trmnl.totalBillCost).toBe(0);
});
