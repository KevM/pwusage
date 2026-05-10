import { loadEnvConfig } from '@next/env';
import path from 'path';

loadEnvConfig(path.resolve(__dirname, '../'));

interface Args {
    siteId?: string;
    days: number;
}

function parseArgs(argv: string[]): Args {
    const args: Args = { days: 14 };
    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];
        if (token === '--site' || token === '--site-id') {
            args.siteId = argv[i + 1];
            i++;
        } else if (token === '--days') {
            const parsed = Number(argv[i + 1]);
            if (!Number.isNaN(parsed) && parsed > 0) args.days = parsed;
            i++;
        }
    }
    return args;
}

async function run(): Promise<void> {
    const { pool } = await import('../src/lib/db');
    const { SiteRepo } = await import('../src/lib/site-repo');
    const args = parseArgs(process.argv.slice(2));
    const siteRepo = new SiteRepo();

    let siteId = args.siteId;
    if (!siteId) {
        const siteIds = await siteRepo.getSiteIds();
        siteId = siteIds[0];
        if (!siteId) throw new Error('No sites found');
        console.log(`No --site provided. Using first site: ${siteId}`);
    }

    const site = await siteRepo.getSite(siteId);
    if (!site) throw new Error(`Site not found: ${siteId}`);

    console.log(`SoC coverage`);
    console.log(`- site: ${siteId}`);
    console.log(`- timezone: ${site.timezone}`);
    console.log(`- days: ${args.days}`);

    const totals = await pool.query<{ total_rows: number; soc_rows: number }>(`
        SELECT
          COUNT(*)::int AS total_rows,
          COUNT(battery_soc)::int AS soc_rows
        FROM "EnergyData"
        WHERE site_id = $1
          AND timestamp >= NOW() - ($2::int || ' days')::interval
    `, [siteId, args.days]);
    console.log(`- totals:`, totals.rows[0]);

    const byDay = await pool.query<{ day: Date; total_rows: number; soc_rows: number }>(`
        SELECT
          date_trunc('day', timestamp AT TIME ZONE $2)::date AS day,
          COUNT(*)::int AS total_rows,
          COUNT(battery_soc)::int AS soc_rows
        FROM "EnergyData"
        WHERE site_id = $1
          AND timestamp >= NOW() - ($3::int || ' days')::interval
        GROUP BY 1
        ORDER BY 1 DESC
    `, [siteId, site.timezone, args.days]);

    console.log('\nPer day:');
    for (const row of byDay.rows) {
        const day = new Date(row.day).toISOString().slice(0, 10);
        console.log(`- ${day}: total=${row.total_rows}, soc=${row.soc_rows}`);
    }

    await pool.end();
}

run().catch((error) => {
    console.error('check-soc-coverage failed:', error);
    process.exit(1);
});
