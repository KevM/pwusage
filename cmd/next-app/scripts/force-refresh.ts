

import fs from 'fs';
import path from 'path';

function loadEnv(filepath: string) {
    try {
        const content = fs.readFileSync(filepath, 'utf8');
        content.split('\n').forEach(line => {
            const [key, ...vals] = line.split('=');
            if (key && vals.length) {
                const val = vals.join('=').trim().replace(/^['"]|['"]$/g, '');
                if (!process.env[key.trim()]) process.env[key.trim()] = val;
            }
        });
    } catch (e) { }
}
loadEnv(path.resolve(__dirname, '../.env.local'));
loadEnv(path.resolve(__dirname, '../.env'));

async function main() {
    const { Pool } = await import('pg');
    const { Importer } = await import('../src/lib/importer');
    const { TeslaClient } = await import('../src/lib/tesla-client');
    const { EnergyRepo } = await import('../src/lib/energy-repo');

    const pool = new Pool({ connectionString: process.env.DATABASE_URL });

    const days = parseInt(process.argv[2] || '7', 10);
    console.log(`Forcing refresh for last ${days} days...`);


    const repo = new EnergyRepo();
    const sites = await repo.getSites();
    if (sites.length === 0) {
        console.error('No sites found.');
        return;
    }
    const site = sites[0]; // Assuming single site for now or easy iteration

    // We need a TeslaClient with tokens.
    // Repo.getSite handles token retrieval if linked to User.
    const fullSite = await repo.getSite(site.id);
    if (!fullSite || !fullSite.access_token) {
        console.error('Site has no tokens.');
        return;
    }

    const client = new TeslaClient({
        accessToken: fullSite.access_token,
        refreshToken: fullSite.refresh_token || undefined,
        onTokenUpdate: async (token, newRefresh) => {
            console.log('Token refreshed.');
            await repo.updateSiteTokens(site.id, token, newRefresh);
        }
    });

    const importer = new Importer(client);

    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - days);

    console.log(`Range: ${start.toISOString()} -> ${end.toISOString()}`);

    await importer.ensureDataForRange(site.id, start, end, (msg) => console.log(msg), { force: true });

    console.log('Done.');
    await pool.end();
}
main().catch(console.error);
