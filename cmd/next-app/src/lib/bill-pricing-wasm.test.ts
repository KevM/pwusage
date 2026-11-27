import { existsSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { priceBillUsage } from './bill-pricing';
import { pricePreviewBill, warmPreviewBillPricing } from './bill-pricing-wasm';
import type { UsageData } from './energy-repo';

function usage(gridUsage: number, buyRate: number, sellRate: number, touName: string): UsageData {
    const start = new Date('2026-11-01T00:00:00Z');
    return {
        start, homeUsage: 4000, gridUsage, solarProduction: 500, batteryChange: 100,
        tariff: { id: 1, site_id: 'test', name: 'Time of use', updated: start },
        touName, buyRate, sellRate,
    };
}

function pricedRows(): UsageData[] {
    const rows = [
        usage(3000, 0.4, 0.1, 'Peak'),
        usage(1000, 0.2, 0.05, 'Peak'),
        usage(-2000, 0.3, 0.08, 'Peak'),
        usage(1000, 0.4, 0.1, 'Off peak'),
        usage(-3000, 0.3, -0.08, 'Off peak'),
    ];
    priceBillUsage(rows);
    return rows;
}

const shouldTestWasm = Boolean(process.env.CI) || existsSync('wasm/bill-pricing.wasm');

describe('preview bill pricing', () => {
    it.runIf(shouldTestWasm)('uses the Swift prices on preview and preserves the other bill fields', async () => {
        vi.stubEnv('VERCEL_ENV', 'preview');
        try {
            warmPreviewBillPricing();
            const expected = pricedRows();
            const actual = await pricePreviewBill(expected);
            expect(actual).not.toBe(expected);
            expect(actual).toEqual(expected);
            const second = await pricePreviewBill(expected);
            expect(second).not.toBe(expected);
            expect(second).toEqual(expected);
        } finally {
            vi.unstubAllEnvs();
        }
    });

    it('keeps the existing prices if the Swift results differ', async () => {
        vi.stubEnv('VERCEL_ENV', 'preview');
        try {
            const expected = pricedRows();
            expected[0].cost = 7;
            expect(await pricePreviewBill(expected)).toBe(expected);
        } finally {
            vi.unstubAllEnvs();
        }
    });

    it.each(['production', 'development'])('keeps existing prices in %s', async environment => {
        vi.stubEnv('VERCEL_ENV', environment);
        try {
            const expected = pricedRows();
            expect(await pricePreviewBill(expected)).toBe(expected);
        } finally {
            vi.unstubAllEnvs();
        }
    });

    it('keeps existing prices for the preview TypeScript control', async () => {
        vi.stubEnv('VERCEL_ENV', 'preview');
        try {
            warmPreviewBillPricing('typescript');
            const expected = pricedRows();
            expect(await pricePreviewBill(expected, 'typescript')).toBe(expected);
        } finally {
            vi.unstubAllEnvs();
        }
    });
});
