import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WASI } from 'node:wasi';
import { logEvent } from './observability';

export type PWUsageCoreJsonExport =
    | 'solar_layout_detect'
    | 'solar_layout_readiness'
    | 'solar_forecast_open_meteo'
    | 'solar_forecast_correct'
    | 'smart_shift_evaluate';

export type PWUsageCoreExports = WebAssembly.Exports & {
    memory: WebAssembly.Memory;
    pw_allocate: (bytes: number) => number;
    pw_free: (pointer: number) => void;
    bill_price: (input: number, inputBytes: number, output: number, outputCount: number) => number;
    solar_layout_detect: (input: number, inputBytes: number, outPtr: number, outBytes: number) => number;
    solar_layout_readiness: (input: number, inputBytes: number, outPtr: number, outBytes: number) => number;
    solar_forecast_open_meteo: (input: number, inputBytes: number, outPtr: number, outBytes: number) => number;
    solar_forecast_correct: (input: number, inputBytes: number, outPtr: number, outBytes: number) => number;
    smart_shift_evaluate: (input: number, inputBytes: number, outPtr: number, outBytes: number) => number;
};

export interface WasmTimeZoneTransition {
    atEpochSeconds: number;
    offsetSeconds: number;
}

export interface WasmSiteTimeZone {
    identifier: string;
    initialOffsetSeconds: number;
    transitions: WasmTimeZoneTransition[];
}

const SIX_HOURS_SECONDS = 6 * 3600;
const DAY_SECONDS = 86_400;
const formatterCache = new Map<string, Intl.DateTimeFormat>();
const transitionCache = new Map<string, WasmSiteTimeZone>();

let coreInstance: Promise<PWUsageCoreExports> | undefined;

async function initializeCore(): Promise<PWUsageCoreExports> {
    const start = performance.now();
    const file = join(process.cwd(), 'wasm/pwusage-core.wasm');
    const bytes = await readFile(file);
    const readMs = performance.now() - start;
    const compiled = await WebAssembly.compile(bytes);
    const compileMs = performance.now() - start - readMs;
    const wasi = new WASI({ version: 'preview1', args: ['PWUsageCoreWasm'] });
    const instance = await WebAssembly.instantiate(compiled, wasi.getImportObject() as WebAssembly.Imports);
    wasi.initialize(instance);
    logEvent('info', 'bill-pricing.wasm.initialized', {
        bytes: bytes.length,
        readMs,
        compileMs,
        instantiateMs: performance.now() - start - readMs - compileMs,
    });
    return instance.exports as PWUsageCoreExports;
}

export function isPWUsageCoreWasmStarted(): boolean {
    return coreInstance !== undefined;
}

export function ensurePWUsageCoreWasm(): Promise<PWUsageCoreExports> {
    coreInstance ??= initializeCore().catch((error: unknown) => {
        coreInstance = undefined;
        throw error;
    });
    return coreInstance;
}

export function warmPWUsageCoreWasm(): void {
    void ensurePWUsageCoreWasm().catch(() => {
        // Failure is handled and logged when a caller awaits ensurePWUsageCoreWasm().
    });
}

/** Call a JSON-in / JSON-out Swift Wasm export and free both Wasm buffers. */
export async function callPWUsageCoreJson<TRequest, TResponse>(
    exportName: PWUsageCoreJsonExport,
    request: TRequest,
): Promise<TResponse> {
    const exports = await ensurePWUsageCoreWasm();
    const payload = Buffer.from(JSON.stringify(request));
    // Layout: [outPtr: i32][outBytes: i32][input bytes...]
    const headerBytes = 8;
    const inputPtr = exports.pw_allocate(headerBytes + Math.max(payload.length, 1));
    let responsePtr = 0;
    try {
        const inputOffset = inputPtr + headerBytes;
        new Uint8Array(exports.memory.buffer).set(payload, inputOffset);
        const status = exports[exportName](inputOffset, payload.length, inputPtr, inputPtr + 4);
        const header = new Int32Array(exports.memory.buffer, inputPtr, 2);
        responsePtr = header[0] >>> 0;
        const responseBytes = header[1];
        if (status !== 0 || responsePtr === 0 || responseBytes < 0) {
            throw new Error(`Swift Wasm ${exportName} failed with status ${status}`);
        }
        const json = Buffer.from(exports.memory.buffer, responsePtr, responseBytes).toString('utf8');
        return JSON.parse(json) as TResponse;
    } finally {
        if (responsePtr !== 0) {
            exports.pw_free(responsePtr);
        }
        exports.pw_free(inputPtr);
    }
}

function getDateTimeFormatter(timeZone: string): Intl.DateTimeFormat {
    let formatter = formatterCache.get(timeZone);
    if (!formatter) {
        formatter = new Intl.DateTimeFormat('en-US', {
            timeZone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hourCycle: 'h23',
        });
        formatterCache.set(timeZone, formatter);
    }
    return formatter;
}

function utcOffsetSecondsAt(formatter: Intl.DateTimeFormat, epochSeconds: number): number {
    const parts = formatter.formatToParts(new Date(epochSeconds * 1000));
    let year = 0;
    let month = 0;
    let day = 0;
    let hour = 0;
    let minute = 0;
    let second = 0;
    for (const part of parts) {
        const numeric = Number(part.value);
        switch (part.type) {
            case 'year':
                year = numeric;
                break;
            case 'month':
                month = numeric;
                break;
            case 'day':
                day = numeric;
                break;
            case 'hour':
                hour = numeric;
                break;
            case 'minute':
                minute = numeric;
                break;
            case 'second':
                second = numeric;
                break;
            default:
                break;
        }
    }
    const localAsUtcSeconds = Math.floor(Date.UTC(year, month - 1, day, hour, minute, second) / 1000);
    return localAsUtcSeconds - epochSeconds;
}

/**
 * Resolve every DST offset transition for an IANA time zone over `[startEpochSec, endEpochSec]`
 * (padded by 16 days before and 4 days after) using V8's built-in IANA TZDB, so Swift Wasm
 * runs exact DST math with `FoundationEssentials` and zero ICU data.
 */
export function buildSiteTimeZone(
    timeZone: string,
    startEpochSec: number,
    endEpochSec: number,
): WasmSiteTimeZone {
    const formatter = getDateTimeFormatter(timeZone);
    const scanStart = Math.floor(Math.min(startEpochSec, endEpochSec)) - 16 * DAY_SECONDS;
    const scanEnd = Math.ceil(Math.max(startEpochSec, endEpochSec)) + 4 * DAY_SECONDS;
    const startYear = new Date(scanStart * 1000).getUTCFullYear();
    const endYear = new Date(scanEnd * 1000).getUTCFullYear();
    const cacheKey = `${timeZone}:${startYear}:${endYear}`;
    const cached = transitionCache.get(cacheKey);
    if (cached) return cached;

    const rangeStart = Math.floor(Date.UTC(startYear, 0, 1) / 1000) - DAY_SECONDS;
    const rangeEnd = Math.floor(Date.UTC(endYear + 1, 0, 1) / 1000) + DAY_SECONDS;
    const initialOffsetSeconds = utcOffsetSecondsAt(formatter, rangeStart);
    const transitions: WasmTimeZoneTransition[] = [];

    let previousEpoch = rangeStart;
    let previousOffset = initialOffsetSeconds;
    for (let cursor = rangeStart + SIX_HOURS_SECONDS; cursor <= rangeEnd; cursor += SIX_HOURS_SECONDS) {
        const currentOffset = utcOffsetSecondsAt(formatter, cursor);
        if (currentOffset !== previousOffset) {
            let low = previousEpoch;
            let high = cursor;
            while (low + 1 < high) {
                const mid = Math.floor((low + high) / 2);
                if (utcOffsetSecondsAt(formatter, mid) === previousOffset) {
                    low = mid;
                } else {
                    high = mid;
                }
            }
            transitions.push({ atEpochSeconds: high, offsetSeconds: currentOffset });
            previousOffset = currentOffset;
        }
        previousEpoch = cursor;
    }

    const result: WasmSiteTimeZone = { identifier: timeZone, initialOffsetSeconds, transitions };
    transitionCache.set(cacheKey, result);
    return result;
}
