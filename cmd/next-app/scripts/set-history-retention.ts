import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { assertRetentionTarget, parseRetentionArgs } from './history-retention-cli';

const HELP = `Manage internal history retention. Defaults to preview; no data is deleted.
  npx tsx scripts/set-history-retention.ts --env dev --user <account-id> --days 90|365 [--apply]
  npx tsx scripts/set-history-retention.ts --env dev --cohort <json-array-of-account-ids> --notice-at <ISO-instant> [--apply --notice-delivered]
DATABASE_URL must match --env local|dev|prod. Load the chosen target into that variable before running.
Bootstrap requires an explicit existing-account cohort and a delivered notice; it sends no messages.`;

async function run(): Promise<void> {
    if (process.argv.includes('--help')) { console.log(HELP); return; }
    const args = parseRetentionArgs(process.argv.slice(2));
    assertRetentionTarget(args.environment, process.env.DATABASE_URL);
    let users: string[];
    if (args.cohort) {
        const cohort: unknown = JSON.parse(await readFile(args.cohort, 'utf8'));
        if (!Array.isArray(cohort) || !cohort.length || !cohort.every((id: unknown) => typeof id === 'string' && id.trim().length > 0)) {
            throw new Error('Cohort must be a nonempty JSON array of account IDs');
        }
        users = [...new Set(cohort as string[])];
        if (!args.noticeAt || args.noticeAt > new Date()) throw new Error('Notice must have already occurred');
    } else users = [args.userId!];
    const { UserRepo } = await import('../src/lib/user-repo');
    const { pool } = await import('../src/lib/db');
    try {
        const repo = new UserRepo();
        // Preflight the entire cohort before any mutations; apply still re-reads under lock.
        for (const userId of users) await repo.getHistoryRetention(userId);
        for (const userId of users) {
            const result = args.noticeAt
                ? await repo.bootstrapHistoryRetention(userId, args.noticeAt, { apply: args.apply })
                : await repo.setHistoryRetention(userId, args.days!, { apply: args.apply });
            console.log(JSON.stringify({ environment: args.environment, ...result }));
        }
    } finally { await pool.end(); }
}

run().catch(() => {
    // Driver errors may contain credentials; never dump connection details.
    console.error('Retention maintenance failed. Check arguments, target, migration, and account IDs. Run --help for usage.');
    process.exitCode = 1;
});
