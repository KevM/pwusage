/**
 * One-off, idempotent backfill: encrypt plaintext `User.access_token` /
 * `User.refresh_token` and fill `User.refresh_token_fp`.
 *
 *   npx tsx scripts/encrypt-tesla-tokens.ts [--dry-run] [--batch-size=100]
 *
 * Needs TOKEN_ENCRYPTION_KEYS and TOKEN_FINGERPRINT_KEY (see example.env) and runs
 * against whatever DATABASE_URL points at. Safe to re-run and safe alongside live
 * refreshes: every write is guarded by the exact old values, so a concurrent
 * rotation wins and the row is skipped (reported as "raced"; re-run to confirm 0).
 */
import './bootstrap-env';

async function main() {
    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run');
    const batchArg = args.find(a => a.startsWith('--batch-size='));
    const batchSize = batchArg ? Number(batchArg.split('=')[1]) : 100;
    if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error('--batch-size must be a positive integer');

    // Imported after bootstrap-env so DATABASE_URL is loaded before the pool is created.
    const { pool } = await import('../src/lib/db');
    const { backfillTeslaTokens } = await import('../src/lib/tesla-token-backfill');
    try {
        console.log(`${dryRun ? 'Dry run: ' : ''}encrypting Tesla tokens in batches of ${batchSize}...`);
        const result = await backfillTeslaTokens(pool, {
            batchSize, dryRun,
            onBatch: p => console.log(`  scanned=${p.scanned} updated=${p.updated} raced=${p.raced}`),
        });
        console.log('Done:', result);
    } finally {
        await pool.end();
    }
}

main().catch(err => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
});
