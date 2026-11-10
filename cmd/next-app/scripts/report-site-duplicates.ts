import { loadEnvConfig } from '@next/env';
import path from 'path';

// Load env before importing app modules that depend on DATABASE_URL.
loadEnvConfig(path.resolve(__dirname, '../'));

/**
 * READ-ONLY report comparing a duplicate site with the real one for the same Powerwall, to decide
 * whether the duplicate's history can simply be dropped or has to be copied (design spec section 10).
 * It only runs SELECTs.
 *
 * Usage:
 *   npx tsx scripts/report-site-duplicates.ts --primary <siteId> --secondary <siteId> [--secondary <siteId> ...]
 */

function args(name: string): string[] {
    const values: string[] = [];
    process.argv.forEach((value, index) => {
        if (value === `--${name}` && process.argv[index + 1]) values.push(process.argv[index + 1]);
    });
    return values;
}

const VERDICTS: Record<string, string> = {
    'not-the-same-home': 'NOT the same home (hardware differs or is missing): do not merge',
    'secondary-has-no-days': 'secondary has no archived days: the existing merge script can handle it',
    'secondary-days-are-duplicates': 'the primary has every secondary day and is at least as complete: the secondary days can be dropped',
    'secondary-has-better-days': 'some secondary days are more complete than the primary\'s: copy those days first',
    'secondary-has-unique-data': 'secondary has days the primary lacks: they must be copied before the merge',
};

async function main() {
    const [primaryId] = args('primary');
    const secondaries = args('secondary');
    if (!primaryId || secondaries.length === 0) {
        console.error('Usage: report-site-duplicates.ts --primary <siteId> --secondary <siteId> [--secondary <siteId> ...]');
        process.exit(2);
    }

    console.log(`Database host: ${new URL(process.env.DATABASE_URL ?? '').hostname}`);
    const { pool } = await import('../src/lib/db');
    const { reportSiteDuplicate } = await import('../src/lib/site-duplicate-report');

    for (const secondaryId of secondaries) {
        const report = await reportSiteDuplicate(pool, primaryId, secondaryId);
        const row = (label: string, side: typeof report.primary) =>
            `  ${label} ${side.id}: ${side.days} days (${side.firstDay ?? '-'} .. ${side.lastDay ?? '-'}), ` +
            `${side.summaries} summaries, ${side.trmnl} TRMNL, ${side.tags} tags`;
        console.log(`\n${primaryId} <- ${secondaryId}`);
        console.log(row('primary  ', report.primary));
        console.log(row('secondary', report.secondary));
        console.log(`  same home: ${report.sameHome}, same timezone: ${report.sameTimezone}`);
        console.log(`  secondary days: ${report.overlap.identical} identical on primary, ` +
            `${report.overlap.differing} differ, ${report.overlap.onlySecondary} only on secondary`);
        console.log(`  completeness on overlapping days: primary better ${report.quality.primaryBetter}, ` +
            `equal ${report.quality.equal}, secondary better ${report.quality.secondaryBetter}`);
        if (report.quality.secondaryBetterDays.length) {
            console.log(`  secondary-better days: ${report.quality.secondaryBetterDays.join(', ')}`);
        }
        console.log(`  verdict: ${VERDICTS[report.verdict]}`);
    }
    process.exit(0);
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
