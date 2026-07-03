import 'dotenv/config';
import { pool } from '../src/lib/db';
import { SiteRepo } from '../src/lib/site-repo';
import { Schedule } from '../src/lib/schedule';

/**
 * Recompute EnergyData.tariff_schedule_id for rows in [start, end) using the
 * current read-time Schedule (including observed-holiday handling).
 *
 * Usage:
 *   npx tsx scripts/fix-tariff-schedule-range.ts --start 2026-07-03 --end 2026-07-04 [--site <siteId>] [--dry-run]
 *
 * IMPORTANT: keep the range narrow and recent. The Schedule is built from the
 * *current* tariff version; recomputing rows that belong to an older tariff
 * version (append-only tariff versioning) would mis-assign them. Only run this
 * over dates whose rows were imported under the current tariff — e.g. the
 * observed-holiday days misclassified before the fix deployed.
 */

function arg(name: string): string | undefined {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
    const startArg = arg('start');
    const endArg = arg('end');
    const siteFilter = arg('site');
    const dryRun = process.argv.includes('--dry-run');

    if (!startArg || !endArg) {
        console.error('Usage: npx tsx scripts/fix-tariff-schedule-range.ts --start YYYY-MM-DD --end YYYY-MM-DD [--site <siteId>] [--dry-run]');
        process.exit(1);
    }
    const start = new Date(`${startArg}T00:00:00Z`);
    const end = new Date(`${endArg}T00:00:00Z`);

    const repo = new SiteRepo();
    const sitesRes = siteFilter
        ? { rows: [{ site_id: siteFilter }] }
        : await pool.query('SELECT DISTINCT site_id FROM "EnergyData" WHERE timestamp >= $1 AND timestamp < $2', [start, end]);

    for (const { site_id: siteId } of sitesRes.rows) {
        const site = await repo.getSite(siteId);
        if (!site) {
            console.log(`[${siteId}] site not found, skipping`);
            continue;
        }
        const schedule = new Schedule(site.tariffs, site.timezone);

        const rowsRes = await pool.query(
            'SELECT id, timestamp, tariff_schedule_id FROM "EnergyData" WHERE site_id = $1 AND timestamp >= $2 AND timestamp < $3',
            [siteId, start, end]
        );

        let changed = 0;
        for (const row of rowsRes.rows) {
            const period = schedule.getTariffPeriod(new Date(row.timestamp));
            const newId = period && Number(period.schedule.id) >= 0 ? Number(period.schedule.id) : null;
            const oldId = row.tariff_schedule_id == null ? null : Number(row.tariff_schedule_id);
            if (newId === oldId) continue;
            changed++;
            if (dryRun) {
                console.log(`[${siteId}] would update row ${row.id} (${new Date(row.timestamp).toISOString()}): ${oldId} -> ${newId}`);
            } else {
                await pool.query('UPDATE "EnergyData" SET tariff_schedule_id = $1 WHERE id = $2', [newId, row.id]);
            }
        }
        console.log(`[${siteId}] rows=${rowsRes.rows.length} ${dryRun ? 'wouldChange' : 'changed'}=${changed}`);
    }
    await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
