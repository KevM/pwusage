import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { WASI } from 'node:wasi';
import { gunzip as gunzipCallback } from 'node:zlib';
import type { UsageData } from './energy-repo';
import { logEvent } from './observability';

const gunzip = promisify(gunzipCallback);

type PricingExports = WebAssembly.Exports & {
    memory: WebAssembly.Memory;
    bill_allocate: (bytes: number) => number;
    bill_free: (pointer: number) => void;
    bill_price: (input: number, inputBytes: number, output: number, outputCount: number) => number;
};

let pricingInstance: Promise<PricingExports> | undefined;
let hasPricedOnce = false;

async function initializePricing(): Promise<PricingExports> {
    const start = performance.now();
    const file = join(process.cwd(), 'wasm/bill-pricing.wasm.gz');
    const compressed = await readFile(file);
    const readMs = performance.now() - start;
    const bytes = await gunzip(compressed);
    const gunzipMs = performance.now() - start - readMs;
    const compiled = await WebAssembly.compile(bytes);
    const compileMs = performance.now() - start - readMs - gunzipMs;
    const wasi = new WASI({ version: 'preview1', args: ['BillPricingWasm'] });
    const instance = await WebAssembly.instantiate(compiled, wasi.getImportObject() as WebAssembly.Imports);
    wasi.initialize(instance);
    logEvent('info', 'bill-pricing.wasm.initialized', {
        compressedBytes: compressed.length,
        bytes: bytes.length,
        readMs,
        gunzipMs,
        compileMs,
        instantiateMs: performance.now() - start - readMs - gunzipMs - compileMs,
    });
    return instance.exports as PricingExports;
}

function ensurePricingInstance(): Promise<PricingExports> {
    pricingInstance ??= initializePricing().catch((error: unknown) => {
        pricingInstance = undefined;
        throw error;
    });
    return pricingInstance;
}

/** Start loading and compiling Wasm before DB queries finish so init overlaps with I/O. */
export function warmPreviewBillPricing(engine?: string): void {
    if (process.env.VERCEL_ENV !== 'preview' || engine === 'typescript') return;
    void ensurePricingInstance().catch(() => {
        // Handled and logged when pricePreviewBill awaits initialization.
    });
}

function priceRows(exports: PricingExports, usage: UsageData[]): number[] {
    const payload = Buffer.from(JSON.stringify(usage.map(row => ({
        planName: row.tariff.name || 'Unknown',
        periodName: row.touName || 'Unknown',
        gridWh: row.gridUsage,
        buyRate: row.buyRate ?? 0,
        sellRate: row.sellRate ?? 0,
    }))));
    const outputOffset = Math.ceil(payload.length / 8) * 8;
    const pointer = exports.bill_allocate(outputOffset + usage.length * 8);
    try {
        const memory = new Uint8Array(exports.memory.buffer);
        memory.set(payload, pointer);
        const output = pointer + outputOffset;
        if (exports.bill_price(pointer, payload.length, output, usage.length) !== 0) {
            throw new Error('Swift rejected the bill pricing input');
        }
        return Array.from(new Float64Array(exports.memory.buffer, output, usage.length));
    } finally {
        exports.bill_free(pointer);
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
    const warmed = pricingInstance !== undefined;
    try {
        const exports = await ensurePricingInstance();
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
