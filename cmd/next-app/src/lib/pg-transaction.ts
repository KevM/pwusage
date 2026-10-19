import type { PoolClient } from 'pg';

/**
 * Supabase's postgresql.conf sets extra_float_digits=0, so text-format float8 reads
 * round to 15 significant digits (7631.409423828125 -> 7631.40942382812). Supavisor
 * drops startup `options` and transaction pooling hands each transaction any backend,
 * so a session-level SET cannot be relied on. SET LOCAL is transaction-scoped and
 * therefore safe under the pooler; 3 makes Postgres emit round-trip-exact doubles.
 */
export const FULL_FLOAT_PRECISION = 'SET LOCAL extra_float_digits = 3';

/** BEGIN (with optional mode) plus full float precision, in one round trip. */
export async function beginTransaction(client: Pick<PoolClient, 'query'>, mode = ''): Promise<void> {
    await client.query(`BEGIN${mode ? ` ${mode}` : ''}; ${FULL_FLOAT_PRECISION}`);
}
