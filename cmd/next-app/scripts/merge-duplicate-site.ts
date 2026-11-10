import { loadEnvConfig } from '@next/env';
import path from 'path';

// Load env before importing app modules that depend on DATABASE_URL.
loadEnvConfig(path.resolve(__dirname, '../'));

/**
 * Merge a duplicate site into the real one for the same Powerwall (design spec section 10).
 *
 * The duplicate's members move to the primary keeping their own Tesla ID, then the duplicate is
 * deleted. It refuses anything with archived days, summaries, TRMNL devices, tags or an active hold.
 * With --drop-secondary-days the duplicate's days (and their summaries) are deleted with it, but only
 * when the primary already holds every one of them at least as completely (a day still open is
 * ignored); run scripts/report-site-duplicates.ts first to see the comparison. TRMNL devices, tags and
 * holds still refuse.
 *
 * SAFETY: dry run by default. Applying needs --apply AND --confirm-host <host of DATABASE_URL>, so a
 * stray .env can't write to the wrong database. Take a backup first (scripts/dump-db-backup.sh) and
 * get the owner's approval before any production run.
 *
 * Usage:
 *   npx tsx scripts/merge-duplicate-site.ts --primary <siteId> --secondary <siteId>
 *   npx tsx scripts/merge-duplicate-site.ts --primary <siteId> --secondary <siteId> --apply --confirm-host <host>
 *   npx tsx scripts/merge-duplicate-site.ts --primary <siteId> --secondary <siteId> --drop-secondary-days [--apply --confirm-host <host>]
 */

function arg(name: string): string | undefined {
    const index = process.argv.indexOf(`--${name}`);
    return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
    const primaryId = arg('primary');
    const secondaryId = arg('secondary');
    const apply = process.argv.includes('--apply');
    const dropSecondaryDays = process.argv.includes('--drop-secondary-days');
    if (!primaryId || !secondaryId) {
        console.error('Usage: merge-duplicate-site.ts --primary <siteId> --secondary <siteId> [--drop-secondary-days] [--apply --confirm-host <host>]');
        process.exit(2);
    }

    const host = new URL(process.env.DATABASE_URL ?? '').hostname;
    console.log(`Database host: ${host}`);
    if (apply && arg('confirm-host') !== host) {
        console.error(`--apply needs --confirm-host ${host}`);
        process.exit(2);
    }

    const { mergeEmptyDuplicateSite } = await import('../src/lib/site-merge');
    const result = await mergeEmptyDuplicateSite({ primaryId, secondaryId, apply, dropSecondaryDays });
    console.log(`${apply ? 'APPLY' : 'DRY RUN'}: ${primaryId} <- ${secondaryId}`);
    if (dropSecondaryDays) console.log(`Days ${result.applied ? 'dropped' : 'to drop'}: ${result.droppedDays}`);
    console.log('Members to move:', result.movedMembers.length ? result.movedMembers : 'none');
    if (result.blockers.length) console.log('Blockers:', result.blockers.join(', '));
    console.log(result.applied ? 'Merged.' : apply ? 'Nothing changed.' : 'Dry run: nothing written.');
    process.exit(result.applied || (!apply && result.blockers.length === 0) ? 0 : 1);
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
