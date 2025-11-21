#!/usr/bin/env tsx
/**
 * Minimal integration check against Tesla Fleet API.
 *
 * Usage:
 *   TESLA_TOKEN=... TESLA_SITE_ID=... TESLA_TIMEZONE=America/Chicago npm run test:fleet
 *   Optional: TESLA_PERIOD=day|week|month|year|5min (default: day), TESLA_START_HOURS_AGO, TESLA_END_HOURS_AGO
 *
 * Notes:
 * - Requires a valid Tesla Fleet access token with energy scope.
 * - Does not write to your DB; it only fetches and validates history.
 * - Adjust TESLA_START_HOURS_AGO / TESLA_END_HOURS_AGO to change the window (defaults: last 24 hours to now).
 */

import { TeslaClient } from '../src/lib/tesla-client';

function getEnv(key: string, required = false): string | undefined {
    const val = process.env[key];
    if (required && !val) {
        throw new Error(`Missing required env var: ${key}`);
    }
    return val;
}

async function main() {
    const token = getEnv('TESLA_TOKEN', true)!;
    const siteId = getEnv('TESLA_SITE_ID', true)!;
    const timeZone = getEnv('TESLA_TIMEZONE') || 'UTC';

    const startHoursAgo = Number(getEnv('TESLA_START_HOURS_AGO') || '24');
    const endHoursAgo = Number(getEnv('TESLA_END_HOURS_AGO') || '0');
    const period = getEnv('TESLA_PERIOD') || 'day'; // "day" works well for fine-grained history; override if needed

    const end = new Date(Date.now() - endHoursAgo * 60 * 60 * 1000);
    const start = new Date(end.getTime() - startHoursAgo * 60 * 60 * 1000);

    console.log(`Fetching history for site ${siteId}`);
    console.log(`Window: ${start.toISOString()} -> ${end.toISOString()} (${timeZone})`);
    console.log(`Period: ${period}`);

    const client = new TeslaClient(token);

    let history;
    try {
        history = await client.getEnergyHistory(siteId, start, end, period, timeZone);
    } catch (err) {
        console.error('Energy history call failed:', err);
        throw err;
    }
    if (!history || history.length === 0) {
        throw new Error('No energy history returned');
    }

    const soe = await client.getSoeHistory(siteId, start, end, period, timeZone);

    // Basic assertions
    console.log(`Energy points: ${history.length}`);
    console.log(`SOC points:    ${soe.length}`);
    console.log(`First energy ts: ${history[0].timestamp}`);
    console.log(`Last energy ts:  ${history[history.length - 1].timestamp}`);

    // Ensure coverage roughly matches expected window (allowing for API gaps).
    const spanMs = new Date(history[history.length - 1].timestamp).getTime() - new Date(history[0].timestamp).getTime();
    const spanHours = spanMs / (1000 * 60 * 60);
    if (spanHours < startHoursAgo / 2) {
        throw new Error(`Unexpectedly short span: ~${spanHours.toFixed(2)}h`);
    }

    console.log('Integration check passed.');
}

main().catch(err => {
    console.error('Integration check failed:', err);
    process.exit(1);
});
