#!/usr/bin/env tsx
/**
 * Background worker to import Tesla data every 5 minutes
 * Run with: npx tsx scripts/worker.ts
 */

const IMPORT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const IMPORT_GRANULARITY = process.env.IMPORT_GRANULARITY || 'day';
const API_URL = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
const IMPORT_TIMEOUT_MS = Number(process.env.IMPORT_TIMEOUT_MS || 600000); // 10 minutes

async function runImport() {
    console.log(`[${new Date().toISOString()}] Starting import...`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), IMPORT_TIMEOUT_MS);

    try {
        const response = await fetch(`${API_URL}/api/import?granularity=${encodeURIComponent(IMPORT_GRANULARITY)}`, {
            method: 'POST',
            signal: controller.signal
        });

        if (!response.ok) {
            const error = await response.text();
            console.error(`Import failed: ${response.status} ${error}`);
            return;
        }

        const result = await response.json();
        console.log(`[${new Date().toISOString()}] Import complete:`, result);
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Import error:`, error);
    } finally {
        clearTimeout(timeout);
    }
}

async function main() {
    console.log('Starting background worker...');
    console.log(`Import interval: ${IMPORT_INTERVAL_MS / 1000}s`);
    console.log(`Import granularity (period): ${IMPORT_GRANULARITY}`);

    // Run immediately on start
    await runImport();

    // Then run every 5 minutes
    setInterval(runImport, IMPORT_INTERVAL_MS);
}

main();
