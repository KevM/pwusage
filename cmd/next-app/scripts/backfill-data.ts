

import { Pool } from 'pg';
import { loadEnvConfig } from '@next/env';
import path from 'path';

// Load Env FIRST
loadEnvConfig(process.cwd());

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function backfill() {
    // Dynamic import to ensure DB pool in lib/db.ts gets the env vars
    const { TeslaClient } = await import('../src/lib/tesla-client');
    const { Importer } = await import('../src/lib/importer');

    console.log('Starting Backfill for Site 2252268092126997...');
    const client = await pool.connect();
    try {
        const siteId = '2252268092126997';

        // 1. Get User ID
        const siteRes = await client.query('SELECT user_id FROM "Site" WHERE id = $1', [siteId]);
        if (siteRes.rows.length === 0) throw new Error('Site not found');
        const userId = siteRes.rows[0].user_id;

        // 2. Get Tokens
        const userRes = await client.query('SELECT access_token, refresh_token FROM "User" WHERE id = $1', [userId]);
        if (userRes.rows.length === 0) throw new Error('User not found');
        const { access_token, refresh_token } = userRes.rows[0];

        // 3. Init Tesla Client
        const teslaClient = new TeslaClient({
            accessToken: access_token,
            refreshToken: refresh_token,
            tokenRefreshHandler: async (rt) => {
                console.log('Refreshing token...');
                const newTokens = await TeslaClient.refreshAccessToken(rt);
                await client.query('UPDATE "User" SET access_token=$1, refresh_token=$2 WHERE id=$3', [newTokens.access_token, newTokens.refresh_token, userId]);
                return newTokens;
            }
        });

        const importer = new Importer(teslaClient);

        // 4. Import Range: Jan 10 2026 (Full CST Day)
        // CST is UTC-6. So Midnight CST is 06:00 UTC.
        const start = new Date('2026-01-10T06:00:00Z');
        const end = new Date('2026-01-11T06:00:00Z');

        console.log(`Importing ${start.toISOString()} to ${end.toISOString()}...`);
        await importer.importRange(siteId, start, end, 'day', (d) => console.log(`Progress: ${d.toISOString()}`));

        console.log('Backfill Complete!');

    } catch (e) {
        console.error(e);
    } finally {
        client.release();
        await pool.end();
    }
}

backfill();

