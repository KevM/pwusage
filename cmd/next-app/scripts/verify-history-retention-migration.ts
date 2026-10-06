import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { assertRetentionTarget } from './history-retention-cli';

async function run(): Promise<void> {
    if (process.argv.includes('--help')) {
        console.log('Rollback-only migration check against an unmigrated dev/local database: npx tsx scripts/verify-history-retention-migration.ts --env dev|local. No lasting schema or data changes. Production refused.');
        return;
    }
    const argv = process.argv.slice(2);
    if (argv.length !== 2 || argv[0] !== '--env' || (argv[1] !== 'dev' && argv[1] !== 'local')) throw new Error('Explicit dev/local target required');
    assertRetentionTarget(argv[1], process.env.DATABASE_URL);
    const sql = await readFile(new URL('../db-migrations/20261006080956_add_history_retention_tier.sql', import.meta.url), 'utf8');
    const { pool } = await import('../src/lib/db');
    const client = await pool.connect();
    const assert = (value: boolean): void => { if (!value) throw new Error('Migration assertion failed'); };
    const columns = async () => (await client.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM information_schema.columns WHERE table_schema='public' AND table_name='User' AND column_name LIKE 'history_retention_%'`)).rows[0].count;
    const security = async () => (await client.query<{ rls: boolean; acl: string | null }>(`SELECT relrowsecurity AS rls, relacl::text AS acl FROM pg_class WHERE oid='public."User"'::regclass`)).rows[0];
    const tariffs = async () => (await client.query(`SELECT
        (SELECT md5(string_agg(to_jsonb(t)::text, ',' ORDER BY id)) FROM public."Tariff" t) AS versions,
        (SELECT md5(string_agg(to_jsonb(t)::text, ',' ORDER BY id)) FROM public."TariffSeason" t) AS seasons,
        (SELECT md5(string_agg(to_jsonb(t)::text, ',' ORDER BY id)) FROM public."TariffSchedule" t) AS schedules`)).rows[0];
    try {
        assert(await columns() === 0);
        await client.query('BEGIN');
        await client.query("SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='15s'");
        const beforeSecurity = JSON.stringify(await security());
        const beforeTariffs = JSON.stringify(await tariffs());
        await client.query(sql);
        const existing = await client.query<{ correct: boolean }>(`SELECT COALESCE(bool_and(history_retention_days=90 AND history_retention_transition_pending AND history_retention_grace_until IS NULL),true) AS correct FROM public."User"`);
        assert(existing.rows[0].correct);
        const ids = [randomUUID(), randomUUID()];
        // Legacy code omits the column. New disclosed-policy code explicitly sets false.
        await client.query('INSERT INTO public."User" (id) VALUES ($1)', [ids[0]]);
        await client.query('INSERT INTO public."User" (id,history_retention_transition_pending) VALUES ($1,FALSE)', [ids[1]]);
        const rows = await client.query<{ id: string; history_retention_days: number; history_retention_transition_pending: boolean }>('SELECT id,history_retention_days,history_retention_transition_pending FROM public."User" WHERE id=ANY($1::text[])', [ids]);
        assert(rows.rows.every(row => row.history_retention_days === 90));
        assert(rows.rows.find(row => row.id === ids[0])?.history_retention_transition_pending === true);
        assert(rows.rows.find(row => row.id === ids[1])?.history_retention_transition_pending === false);
        await client.query('SAVEPOINT invalid_days');
        let rejected = false;
        try { await client.query('UPDATE public."User" SET history_retention_days=180 WHERE id=$1', [ids[0]]); }
        catch (error) { rejected = typeof error === 'object' && error !== null && 'code' in error && error.code === '23514'; }
        await client.query('ROLLBACK TO SAVEPOINT invalid_days');
        assert(rejected);
        assert(beforeSecurity === JSON.stringify(await security()));
        assert(beforeTariffs === JSON.stringify(await tariffs()));
        await client.query('ROLLBACK');
        assert(await columns() === 0);
        console.log(JSON.stringify({ result: 'PASS', existingPending: true, legacySignupPending: true, disclosedSignup90: true, invalidDaysRejected: true, rlsAndGrantsUnchanged: true, allTariffValuesUnchanged: true, rollbackVerified: true }));
    } finally {
        try { await client.query('ROLLBACK'); } finally { client.release(); await pool.end(); }
    }
}
run().catch(() => { console.error('Rollback-only retention migration verification failed. Check unmigrated dev/local target and database access.'); process.exitCode = 1; });
