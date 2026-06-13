import path from 'path';
import dotenv from 'dotenv';

// Load Env
dotenv.config({ path: path.resolve(__dirname, '../.env'), override: true });

async function main() {
    const siteId = process.argv[2];
    const startDateArg = process.argv[3];
    if (!siteId) {
        console.error('usage: npx tsx scripts/backfill-charge-split.ts <siteId> [startDateYYYY-MM-DD]');
        process.exit(1);
    }

    // Dynamic imports to prevent hoisting order issues with DATABASE_URL
    const { TeslaClient } = await import('../src/lib/tesla-client');
    const { Importer } = await import('../src/lib/importer');
    const { SiteRepo } = await import('../src/lib/site-repo');
    const { pool } = await import('../src/lib/db');
    const { RollupRepo } = await import('../src/lib/battery-provenance/rollup-repo');
    const { RollupService } = await import('../src/lib/battery-provenance/rollup-service');
    const { EnergyRepo } = await import('../src/lib/energy-repo');
    const { localDateKey } = await import('../src/lib/battery-provenance/local-day');

    // Fetch site & user token
    const siteRepo = new SiteRepo();
    const site = await siteRepo.getSite(siteId);
    if (!site) {
        console.error(`Site ${siteId} not found in database!`);
        process.exit(1);
    }

    const energyRepo = new EnergyRepo();
    const rollupRepo = new RollupRepo();
    const rollupService = new RollupService({
        loadSite: async () => ({ id: site.id, timezone: site.timezone, tariffs: site.tariffs ?? [] }),
        loadEnergyData: (id, start, end) => energyRepo.getRawEnergyData(id, start, end),
        getSeedTank: (id, beforeTs) => rollupRepo.getSeedTank(id, beforeTs),
        hasAnyRollup: (id) => rollupRepo.hasAnyRollup(id),
        upsertRollups: (rows) => rollupRepo.upsertRollups(rows),
    });

    const installDate = new Date(site.installed);
    let start = new Date(installDate);
    if (startDateArg) {
        const parsedDate = new Date(startDateArg);
        if (isNaN(parsedDate.getTime())) {
            console.error(`Invalid startDate format: "${startDateArg}". Please use YYYY-MM-DD.`);
            process.exit(1);
        }
        start = parsedDate;
    }
    const end = new Date(Date.now() - 24 * 60 * 60 * 1000); // Up to yesterday
    
    // Ensure we start at midnight of the target date
    start.setUTCHours(0, 0, 0, 0);
    end.setUTCHours(23, 59, 59, 999);

    const userRes = await pool.query('SELECT access_token FROM "User" WHERE id = $1', [site.user_id]);
    const token = userRes.rows[0]?.access_token;
    if (!token) {
        console.error(`No access token found for user ${site.user_id}!`);
        process.exit(1);
    }

    const client = new TeslaClient({ accessToken: token });
    const importer = new Importer(client);

    console.log(`Site: ${site.name} (Installed: ${installDate.toISOString().slice(0, 10)})`);
    console.log(`Starting rate-limited charge-split backfill from start date ${start.toISOString().slice(0, 10)} to yesterday ${end.toISOString().slice(0, 10)}...`);

    const allRows = [];
    const dayMs = 24 * 60 * 60 * 1000;
    let cursor = new Date(start);
    const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

    const fetchWithRetry = async (chunkStart: Date, next: Date, retries = 3, initialDelay = 5000): Promise<any[]> => {
        let delay = initialDelay;
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                return await importer.importRange(siteId, chunkStart, next, 'day');
            } catch (e) {
                if (attempt === retries) {
                    throw e;
                }
                console.warn(`[Attempt ${attempt + 1}/${retries + 1}] Error importing ${chunkStart.toISOString().slice(0, 10)}, backing off ${delay / 1000}s and retrying...`, e);
                await sleep(delay);
                delay *= 2; // Exponential backoff
            }
        }
        return [];
    };

    while (cursor < end) {
        const next = new Date(Math.min(cursor.getTime() + dayMs - 1, end.getTime()));
        const chunkStart = new Date(cursor);
        console.log(`Importing day: ${chunkStart.toISOString().slice(0, 10)}...`);

        try {
            const rows = await fetchWithRetry(chunkStart, next);
            allRows.push(...rows);
            
            const localDate = localDateKey(chunkStart, site.timezone);
            const { rollupCount } = await rollupService.rollupDay(siteId, localDate);
            if (rollupCount > 0) {
                console.log(`  [Rollup] Completed rollup for ${localDate} (${rollupCount} periods)`);
            }
        } catch (e) {
            console.error(`Failed all retry attempts for ${chunkStart.toISOString().slice(0, 10)}. Skipping day to prevent crash:`, e);
        }

        cursor = new Date(cursor.getTime() + dayMs);
        await sleep(2500); // 2.5s delay between days to avoid 529 site overloaded errors
    }

    console.log(`done: ${allRows.length} rows re-imported with charge split`);
}

main()
    .then(() => process.exit(0))
    .catch((e) => {
        console.error(e);
        process.exit(1);
    });
