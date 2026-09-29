/**
 * Captures a real Solcast response so the iOS decoder can be checked against the
 * provider rather than against fixtures we authored ourselves.
 *
 * This exists because every automated test used a synthetic payload, which is how
 * a megawatt/kilowatt unit error survived review. Ground truth beats a fixture we
 * agree with.
 *
 * Usage:
 *   SOLCAST_API_KEY=... SOLCAST_RESOURCE_ID=... npx tsx scripts/solcast-forecast-capture.ts
 *
 * The API key is read from the environment only and is never written, logged, or
 * echoed. The resource ID is redacted in the output, because the design requires
 * keys and resource IDs to stay device-local.
 *
 * Output is written OUTSIDE the repository by default. Pass --out <path> to
 * override. Nothing here should ever be committed with a live resource ID.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ORIGIN = 'https://api.solcast.com.au';
const REDACTED_ID = 'redacted-resource-id';

type Unknown = Record<string, unknown>;

function required(name: string): string {
    const value = process.env[name];
    if (!value) {
        console.error(`Missing ${name}. Set it in the environment or .env before running.`);
        process.exit(2);
    }
    return value.trim();
}

function redacted(resourceID: string): string {
    // Keep the shape (length class, character class) so encoding and path-safety
    // behaviour is still exercised, without recording the real identifier.
    return `${REDACTED_ID}-${'x'.repeat(Math.min(resourceID.length, 8))}`;
}

function redactForecast(forecasts: unknown[]): unknown[] {
    return forecasts.map((point) => {
        const { pv_estimate10, pv_estimate90, ...rest } = point as Unknown;
        const out: Unknown = { ...rest };
        if (pv_estimate10 !== undefined) out.pv_estimate10 = pv_estimate10;
        if (pv_estimate90 !== undefined) out.pv_estimate90 = pv_estimate90;
        return out;
    });
}

async function get(pathname: string, apiKey: string): Promise<unknown> {
    const url = new URL(pathname, ORIGIN);
    url.searchParams.set('format', 'json');
    const response = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    });
    const text = await response.text();
    if (!response.ok) {
        // Never echo the body of an error response; it is provider data.
        throw new Error(`Solcast returned ${response.status} ${response.statusText} for ${pathname}`);
    }
    try {
        return JSON.parse(text);
    } catch {
        throw new Error(`Solcast returned a non-JSON body for ${pathname}`);
    }
}

function describe(label: string, value: unknown): void {
    console.log(`\n== ${label} ==`);
    if (Array.isArray(value)) {
        console.log(`  array length: ${value.length}`);
        if (value.length > 0 && typeof value[0] === 'object' && value[0] !== null) {
            console.log(`  keys: ${Object.keys(value[0] as Unknown).sort().join(', ')}`);
        }
        return;
    }
    if (value && typeof value === 'object') {
        console.log(`  keys: ${Object.keys(value as Unknown).sort().join(', ')}`);
        return;
    }
    console.log(`  type: ${typeof value}`);
}

async function run(): Promise<void> {
    const apiKey = required('SOLCAST_API_KEY');
    const resourceID = required('SOLCAST_RESOURCE_ID');

    const outIndex = process.argv.indexOf('--out');
    const outPath = outIndex >= 0 && process.argv[outIndex + 1]
        ? process.argv[outIndex + 1]
        : path.resolve(process.env.TMPDIR ?? '/tmp', 'solcast-capture.json');

    console.log(`Fetching discovery and forecast for a redacted resource (${redacted(resourceID)}).`);

    const sites = await get('/rooftop_sites', apiKey);
    const forecasts = await get(`/rooftop_sites/${encodeURIComponent(resourceID)}/forecasts`, apiKey);

    describe('discovery response', sites);
    describe('forecast response', forecasts);

    const points = Array.isArray((forecasts as Unknown).forecasts)
        ? (redactForecast((forecasts as Unknown).forecasts as unknown[]))
        : [];

    if (points.length === 0) {
        throw new Error('The forecast response contained no points; nothing to capture.');
    }

    const sample = points[0] as Unknown;
    const rawEstimate = Number(sample.pv_estimate);
    console.log('\n== magnitude check ==');
    console.log(`  pv_estimate (raw): ${rawEstimate}`);
    console.log('  If this is around 0.001-0.02 the provider is reporting MW; the app');
    console.log('  must convert to kW by multiplying by 1000 before any cost maths.');

    const payload = {
        _note: 'Redacted Solcast capture. Resource IDs removed; the API key is never written.',
        _capturedAt: new Date().toISOString(),
        discovery: {
            sites: ((sites as Unknown).sites as Unknown[] | undefined)?.map((site) => ({
                resource_id: redacted(String(site.resource_id ?? '')),
                name: 'redacted',
                tags: Array.isArray(site.tags) ? site.tags.map(() => 'redacted') : [],
            })) ?? [],
        },
        forecast: { forecasts: points },
    };

    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
    console.log(`\nWrote ${points.length} forecast points to ${outPath}`);
    console.log('Check that this file contains no live key or resource ID before sharing it.');
}

run().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
