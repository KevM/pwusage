import 'dotenv/config';
import { pool } from '../src/lib/db';
import { SiteRepo } from '../src/lib/site-repo';
import { Schedule } from '../src/lib/schedule';
import { parseSiteLocalDateToMidnight } from '../src/lib/date-utils';

/**
 * Recompute EnergyData.tariff_schedule_id for rows in site-local [start, end)
 * using the current read-time Schedule (including observed-holiday handling).
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

export function getSiteLocalRepairBounds(startArg: string, endArg: string, timezone: string): { siteStart: Date; siteEnd: Date } {
    const startDateStr = startArg.split('T')[0];
    const endDateStr = endArg.split('T')[0];
    const siteStart = parseSiteLocalDateToMidnight(startDateStr, timezone);
    const siteEnd = parseSiteLocalDateToMidnight(endDateStr, timezone);
    return { siteStart, siteEnd };
}

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

    const startDateStr = startArg.split('T')[0];
    const endDateStr = endArg.split('T')[0];
    const approxStart = new Date(`${startDateStr}T00:00:00Z`);
    const approxEnd = new Date(`${endDateStr}T00:00:00Z`);

    const daysDiff = (approxEnd.getTime() - approxStart.getTime()) / (1000 * 60 * 60 * 24);
    const force = process.argv.includes('--force');
    if (daysDiff > 31 && !force) {
        console.error('Error: Range exceeds 31 days. Recomputing wide date ranges with current tariffs can mis-assign rows belonging to older tariff versions. Pass --force to override.');
        process.exit(1);
    }

    const repo = new SiteRepo();

    // Widened UTC window to candidate-search sites across all timezones (UTC-12 to UTC+14)
    const utcStartCandidate = new Date(approxStart.getTime() - 36 * 3600 * 1000);
    const utcEndCandidate = new Date(approxEnd.getTime() + 36 * 3600 * 1000);

    const sitesRes = siteFilter
        ? { rows: [{ site_id: siteFilter }] }
        : await pool.query(
            'SELECT DISTINCT site_id FROM "EnergyData" WHERE timestamp >= $1 AND timestamp < $2',
            [utcStartCandidate, utcEndCandidate]
        );

    for (const { site_id: siteId } of sitesRes.rows) {
        const site = await repo.getSite(siteId);
        if (!site) {
            console.log(`[${siteId}] site not found, skipping`);
            continue;
        }
        const schedule = new Schedule(site.tariffs, site.timezone);
        const { siteStart, siteEnd } = getSiteLocalRepairBounds(startArg, endArg, site.timezone);

        const rowsRes = await pool.query(
            'SELECT id, timestamp, tariff_schedule_id FROM "EnergyData" WHERE site_id = $1 AND timestamp >= $2 AND timestamp < $3',
            [siteId, siteStart, siteEnd]
        );

        let changed = 0;
        for (const row of rowsRes.rows) {
            const period = schedule.getTariffPeriod(new Date(row.timestamp));
            const newId = period?.schedule.id != null ? Number(period.schedule.id) : null;
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

if (process.argv[1]?.endsWith('fix-tariff-schedule-range.ts')) {
    main().catch((err) => { console.error(err); process.exit(1); });
}
