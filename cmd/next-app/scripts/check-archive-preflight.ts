import 'dotenv/config';
import {pathToFileURL} from 'node:url';
import {pool} from '../src/lib/db';

/**
 * Read-only archive preflight. Confirms the hosted database can actually run the
 * transactions the archival subsystem depends on. Never mutates any row.
 *
 * Usage: npx tsx scripts/check-archive-preflight.ts
 */

interface Probe {name:string;ok:boolean;detail:string}

const devRef = 'aipxozppjmijrpwyuvuo';

export async function runArchivePreflight():Promise<void> {
    const url = new URL(process.env.DATABASE_URL ?? '');
    const target = url.hostname.includes(devRef) || url.username.endsWith(`.${devRef}`)
        ? 'Dev' : 'UNKNOWN (not the verified Dev project ref)';
    console.log(`Target: ${target}`);
    console.log(`Host:   ${url.hostname}:${url.port || 5432}`);
    console.log('');

    const probes: Probe[] = [];
    const record = (name: string, ok: boolean, detail: string): void => { probes.push({name, ok, detail}); };

    // 1. Server version. transaction_timeout requires PostgreSQL 17+.
    const version = await pool.query<{server_version:string;server_version_num:string}>(
        'SELECT current_setting($1) AS server_version, current_setting($2) AS server_version_num',
        ['server_version', 'server_version_num']);
    const raw = version.rows[0];
    if (!raw) throw new Error('Could not read server version');
    // server_version_num is an integer like 170006 (17.6); derive the major from the
    // first two digits rather than splitting on '.', which only exists in server_version.
    const major = Math.floor(Number(String(raw.server_version_num)) / 10000);
    record('server_version', major >= 17,
        `${raw.server_version} (major ${major}${major >= 17 ? '' : ' — requires 17+'})`);

    // 2. transaction_timeout is settable by this role, not merely present.
    try {
        const tt = await pool.query<{transaction_timeout:string}>('SELECT current_setting($1) AS transaction_timeout', ['transaction_timeout']);
        record('transaction_timeout_readable', true, `current value = ${tt.rows[0]?.transaction_timeout ?? 'unknown'}`);
    } catch (error) {
        record('transaction_timeout_readable', false,
            error instanceof Error ? error.message : 'unrecognized configuration parameter');
    }

    // 3. SET LOCAL transaction_timeout actually applies inside an explicit transaction.
    //    This is the exact shape CompactHistoryStore.boundTransaction uses.
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query("SET LOCAL transaction_timeout='15s'");
        const applied = await client.query<{transaction_timeout:string}>(
            'SELECT current_setting($1) AS transaction_timeout', ['transaction_timeout']);
        const appliedTimeout = applied.rows[0]?.transaction_timeout;
        const appliedOk = appliedTimeout === '15s' || appliedTimeout === '15000ms';
        record('set_local_transaction_timeout', appliedOk,
            appliedOk ? `applied = ${appliedTimeout}` : `expected 15s, got ${appliedTimeout ?? 'unknown'}`);
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        record('set_local_transaction_timeout', false,
            error instanceof Error ? error.message : 'SET LOCAL failed');
    } finally {
        client.release();
    }

    // 4. Advisory locks survive Supavisor transaction pooling. The run claim depends
    //    on this: a session-level lock would be silently lost on backend reassignment.
    const lockClient = await pool.connect();
    try {
        await lockClient.query('BEGIN');
        const lock = await lockClient.query<{xact:boolean}>(
            'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS xact', ['archive-preflight-probe']);
        record('advisory_xact_lock', lock.rows[0]?.xact === true,
            lock.rows[0]?.xact === true ? 'transaction-level lock acquired' : 'lock unavailable');
        await lockClient.query('ROLLBACK');
    } catch (error) {
        await lockClient.query('ROLLBACK').catch(() => undefined);
        record('advisory_xact_lock', false, error instanceof Error ? error.message : 'lock failed');
    } finally {
        lockClient.release();
    }

    // 5. Archive migrations are applied and the control row exists.
    try {
        const expectedTables = ['EnergyDayArchive', 'EnergyDaySummary', 'HistoryArchiveControl', 'HistoryArchiveRetry'];
        const tables = await pool.query<{name:string}>(
            `SELECT table_name AS name FROM information_schema.tables
             WHERE table_schema='public' AND table_name = ANY($1::text[])
             ORDER BY table_name`,
            [expectedTables]);
        const found = tables.rows.map(r => r.name);
        const missing = expectedTables.filter(name => !found.includes(name));
        record('archive_tables', missing.length === 0, missing.length === 0 ? found.join(', ') : `missing: ${missing.join(', ')}`);
    } catch (error) {
        record('archive_tables', false, error instanceof Error ? error.message : 'query failed');
    }

    try {
        const control = await pool.query<{paused:boolean;trim:boolean;site_ids:string[]}>(
            'SELECT paused, trim, site_ids FROM "HistoryArchiveControl" WHERE id=true');
        const row = control.rows[0];
        record('archive_control_present', Boolean(row),
            row ? `paused=${row.paused} trim=${row.trim} cohort=${row.site_ids.length} site(s)` : 'control row missing — migration not applied');
    } catch (error) {
        record('archive_control_present', false, error instanceof Error ? error.message : 'query failed');
    }

    // 6. Anything actually pruned yet? Relevant before the first trim decision.
    try {
        const pruned = await pool.query<{days:number}>(
            'SELECT count(*)::int AS days FROM "EnergyDayArchive" WHERE raw_pruned');
        const days = pruned.rows[0]?.days ?? 0;
        record('pruned_days', true, days === 0 ? 'none (no raw rows deleted yet)' : `${days} day(s) already trimmed`);
    } catch (error) {
        record('pruned_days', false, error instanceof Error ? error.message : 'pruning query failed');
    }

    console.log(JSON.stringify({target, probes}, null, 2));

    const failed = probes.filter(p => !p.ok);
    if (failed.length) {
        console.error('');
        console.error(`PREFLIGHT FAILED: ${failed.length} check(s) did not pass: ${failed.map(p => p.name).join(', ')}`);
        process.exitCode = 1;
        return;
    }
    console.log('');
    console.log('Preflight passed. Read-only checks only; no rows were changed.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    runArchivePreflight()
        .catch(error => {
            console.error(error instanceof Error ? error.message : 'Preflight failed');
            process.exitCode = 1;
        })
        .finally(() => pool.end());
}
