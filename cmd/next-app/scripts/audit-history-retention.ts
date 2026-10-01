import 'dotenv/config';
import { assertRetentionTarget, parseRetentionAuditArgs } from './history-retention-cli';

async function run(): Promise<void> {
    if (process.argv.includes('--help')) {
        console.log('Read-only retention audit: npx tsx scripts/audit-history-retention.ts --env local|dev|prod [--as-of ISO-instant]\nDATABASE_URL must match the explicit environment. Requires the retention migration. No data is deleted.');
        return;
    }
    const args = parseRetentionAuditArgs(process.argv.slice(2));
    assertRetentionTarget(args.environment, process.env.DATABASE_URL);
    const { pool } = await import('../src/lib/db');
    const { HistoryRetentionRepo } = await import('../src/lib/history-retention-repo');
    const { HistoryRetentionService } = await import('../src/lib/history-retention-service');
    const client = await pool.connect();
    try {
        await client.query('BEGIN READ ONLY');
        await client.query("SET LOCAL statement_timeout = '15s'");
        const repo = new HistoryRetentionRepo({ query: client.query.bind(client), connect: async () => { throw new Error('Read-only audit cannot lock for writes'); } });
        const noDelete = { deleteExpiredBatch: async (): Promise<number> => { throw new Error('Read-only audit cannot delete'); } };
        const report = await new HistoryRetentionService({ repo, energy: noDelete, tags: noDelete }).run({ now: args.asOf });
        const sizes = await client.query<{ database_bytes: string; energy_bytes: string; energy_heap_bytes: string; energy_index_bytes: string; energy_rows: string }>(`
            SELECT pg_database_size(current_database())::text AS database_bytes,
                pg_total_relation_size('"EnergyData"')::text AS energy_bytes,
                pg_relation_size('"EnergyData"')::text AS energy_heap_bytes,
                pg_indexes_size('"EnergyData"')::text AS energy_index_bytes,
                (SELECT COUNT(*)::text FROM "EnergyData") AS energy_rows
        `);
        const size = sizes.rows[0];
        const rows = Number(size.energy_rows);
        const eligible = report.sites.reduce((sum, site) => sum + site.eligibleEnergy, 0);
        console.log(JSON.stringify({ environment: args.environment, ...report, storage: {
            ...size, eligible_energy_rows: eligible, estimated_retained_rows: rows - eligible,
            estimated_retained_row_allocation_bytes: rows ? Math.round(Number(size.energy_bytes) * (rows - eligible) / rows) : 0,
            estimate_note: 'Allocated bytes per row are approximate. Deleting rows does not promise a reduction in database file size.',
        } }, null, 2));
    } finally {
        try { await client.query('ROLLBACK'); } finally { client.release(); await pool.end(); }
    }
}
run().catch(() => {
    console.error('Read-only retention audit failed. Check arguments, target, migration, and database access. Run --help for usage.');
    process.exitCode = 1;
});
