import { describe, expect, it } from 'vitest';
import { buildBillOutlookHistory, type BillOutlookBucket } from './bill-outlook-history';

const bucket = (netGridKwh: number, buyRate = 0.3): BillOutlookBucket => ({
    tariffName: 'Utility', periodName: 'Peak', netGridKwh, buyRate, sellRate: 0.04,
});
describe('recorded bill outlook history', () => {
    it('nets cumulative original rate buckets rather than daily settled costs', () => {
        const result = buildBillOutlookHistory([
            { date: '2026-10-01T00:00:00Z', buckets: [bucket(-27.471)], complete: true },
            { date: '2026-10-02T00:00:00Z', buckets: [bucket(18.243, 0.31)], complete: true },
        ]);
        expect(result[1].estimatedCost).toBeCloseTo(-0.36912);
        expect(result[1].buckets).toHaveLength(2);
        expect(result[1].periods[0].netGridKwh).toBeCloseTo(-9.228);
    });
    it('merges the same rate bucket before pricing subsequent offsets', () => {
        const result = buildBillOutlookHistory([
            { date: '2026-10-01T00:00:00Z', buckets: [bucket(10)], complete: true },
            { date: '2026-10-02T00:00:00Z', buckets: [bucket(-5)], complete: true },
        ]);
        expect(result[1].buckets).toEqual([bucket(5)]);
        expect(result[1].estimatedCost).toBeCloseTo(1.5);
    });
    it('does not make cumulative history complete again after a missing day', () => {
        const result = buildBillOutlookHistory([
            { date: '2026-10-01T00:00:00Z', buckets: [], complete: false },
            { date: '2026-10-02T00:00:00Z', buckets: [bucket(5)], complete: true },
        ]);
        expect(result.every(point => !point.complete)).toBe(true);
    });
});
