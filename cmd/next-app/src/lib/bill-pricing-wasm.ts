import type { UsageData } from './energy-repo';
import { logEvent } from './observability';
import {
    ensurePWUsageCoreWasm,
    isPWUsageCoreWasmStarted,
    warmPWUsageCoreWasm,
    type PWUsageCoreExports,
} from './pwusage-core-wasm';

let hasPricedOnce = false;

/** Start loading and compiling Wasm before DB queries finish so init overlaps with I/O. */
export function warmPreviewBillPricing(engine?: string): void {
    if (process.env.VERCEL_ENV !== 'preview' || engine === 'typescript') return;
    warmPWUsageCoreWasm();
}

function priceRows(exports: PWUsageCoreExports, usage: UsageData[]): number[] {
    const payload = Buffer.from(JSON.stringify(usage.map(row => ({
        planName: row.tariff.name || 'Unknown',
        periodName: row.touName || 'Unknown',
        gridWh: row.gridUsage,
        buyRate: row.buyRate ?? 0,
        sellRate: row.sellRate ?? 0,
    }))));
    const outputOffset = Math.ceil(payload.length / 8) * 8;
    const pointer = exports.pw_allocate(outputOffset + usage.length * 8);
    try {
        const memory = new Uint8Array(exports.memory.buffer);
        memory.set(payload, pointer);
        const output = pointer + outputOffset;
        if (exports.bill_price(pointer, payload.length, output, usage.length) !== 0) {
            throw new Error('Swift rejected the bill pricing input');
        }
        return Array.from(new Float64Array(exports.memory.buffer, output, usage.length));
    } finally {
        exports.pw_free(pointer);
    }
}

/** Preview-only experiment. Keep the TypeScript prices when the result differs or Wasm fails. */
export async function pricePreviewBill(usage: UsageData[], engine?: string): Promise<UsageData[]> {
    if (process.env.VERCEL_ENV !== 'preview' || usage.length === 0) return usage;
    if (engine === 'typescript') {
        logEvent('info', 'bill-pricing.preview', { engine, rows: usage.length });
        return usage;
    }

    const start = performance.now();
    const cold = !hasPricedOnce;
    const warmed = isPWUsageCoreWasmStarted();
    try {
        const exports = await ensurePWUsageCoreWasm();
        const readyAt = performance.now();
        const costs = priceRows(exports, usage);
        hasPricedOnce = true;
        const matches = usage.every((row, index) => Math.abs(costs[index] - (row.cost ?? 0)) <= 1e-9);
        logEvent(matches ? 'info' : 'warn', 'bill-pricing.preview', {
            engine: matches ? 'swift-wasm' : 'typescript', cold, warmed, rows: usage.length, matches,
            loadMs: readyAt - start, pricingMs: performance.now() - readyAt,
        });
        return matches ? usage.map((row, index) => ({ ...row, cost: costs[index] })) : usage;
    } catch {
        logEvent('warn', 'bill-pricing.preview', {
            engine: 'typescript', cold, warmed, rows: usage.length, failed: true, durationMs: performance.now() - start,
        });
        return usage;
    }
}
