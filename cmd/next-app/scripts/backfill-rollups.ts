import path from 'path';
import dotenv from 'dotenv';

// Load Env
dotenv.config({ path: path.resolve(__dirname, '../.env'), override: true });

async function main() {
    const siteId = process.argv[2];
    if (!siteId) {
        console.error('usage: npx tsx scripts/backfill-rollups.ts <siteId>');
        process.exit(1);
    }

    // Dynamic imports to prevent hoisting order issues with DATABASE_URL
    const { SiteRepo } = await import('../src/lib/site-repo');
    const { EnergyRepo } = await import('../src/lib/energy-repo');
    const { RollupRepo } = await import('../src/lib/battery-provenance/rollup-repo');
    const { HourlyRepo } = await import('../src/lib/battery-provenance/hourly-repo');
    const { RollupService } = await import('../src/lib/battery-provenance/rollup-service');
    const { localDateKey } = await import('../src/lib/battery-provenance/local-day');
    const { pool } = await import('../src/lib/db');

    const siteRepo = new SiteRepo();
    const energyRepo = new EnergyRepo();
    const rollupRepo = new RollupRepo();
    const hourlyRepo = new HourlyRepo();
    const site = await siteRepo.getSite(siteId);
    if (!site) throw new Error(`site ${siteId} not found`);

    const service = new RollupService({
        loadSite: async () => ({ id: site.id, timezone: site.timezone, tariffs: site.tariffs ?? [] }),
        loadEnergyData: (id, start, end) => energyRepo.getRawEnergyData(id, start, end),
        getSeedTank: (id, beforeTs) => rollupRepo.getSeedTank(id, beforeTs),
        hasAnyRollup: (id) => rollupRepo.hasAnyRollup(id),
        upsertRollups: (rows) => rollupRepo.upsertRollups(rows),
        upsertHourly: (rows) => hourlyRepo.upsertHourly(rows),
    });

    // Earliest local date present.
    console.log('Finding earliest energy data point...');
    const res = await pool.query('SELECT MIN(timestamp) as min_ts FROM "EnergyData" WHERE site_id = $1', [siteId]);
    const firstVal = res.rows[0]?.min_ts;
    if (!firstVal) {
        console.log('no energy data found for site');
        return;
    }
    const first = new Date(firstVal);

    let cursor = new Date(`${localDateKey(first, site.timezone)}T12:00:00Z`);
    const stop = new Date(Date.now() - 24 * 60 * 60 * 1000);
    console.log(`Starting rollup backfill from ${localDateKey(first, site.timezone)} to ${localDateKey(stop, site.timezone)}...`);

    while (cursor <= stop) {
        const localDate = localDateKey(cursor, site.timezone);
        const { rollupCount } = await service.rollupDay(siteId, localDate);
        if (rollupCount > 0) {
            console.log(`Rolled up date ${localDate}: ${rollupCount} periods`);
        }
        cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
    }
    console.log('backfill complete');
}

main()
    .then(() => process.exit(0))
    .catch((e) => {
        console.error(e);
        process.exit(1);
    });
