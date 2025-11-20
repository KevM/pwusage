#!/usr/bin/env tsx
/**
 * Background worker to import Tesla data every 5 minutes
 * Run with: npx tsx scripts/worker.ts
 */

const IMPORT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5173';

async function runImport() {
    console.log(`[${new Date().toISOString()}] Starting import...`);

    try {
        const response = await fetch(`${API_URL}/api/import`, {
            method: 'POST',
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
    }
}

async function main() {
    console.log('Starting background worker...');
    console.log(`Import interval: ${IMPORT_INTERVAL_MS / 1000}s`);

    // Run immediately on start
    await runImport();

    // Then run every 5 minutes
    setInterval(runImport, IMPORT_INTERVAL_MS);
}

main();
