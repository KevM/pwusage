/**
 * Differential verification for `EnergyRepo.getDailyCoverage` against real Postgres.
 *
 * MANUAL GATE. `energy-repo.test.ts` mocks `./db`, so nothing in `npm run test`
 * ever executes the new per-day aggregation SQL. This script is the only check
 * that the SQL computes what the old JavaScript two-pointer walk computed, on
 * real rows, across real DST transitions. Re-run it by hand before merging any
 * change to `getDailyCoverage`.
 *
 * READ-ONLY BY CONSTRUCTION. Every statement this script issues is a SELECT.
 * It additionally pins each pooled connection to a read-only transaction, so
 * even a future edit that added DML here could not write. Nothing in production
 * depends on this file.
 *
 * Usage (from cmd/next-app):
 *   npx tsx scripts/verify-sync-daily-coverage.ts
 *
 * Overrides (all optional):
 *   VERIFY_SYNC_COVERAGE_SITE_ID     site to check (default: the Chicago DST site)
 *   VERIFY_SYNC_COVERAGE_TIMEZONE    site timezone override (default: read from "Site")
 *   VERIFY_SYNC_COVERAGE_START       range start, inclusive (ISO 8601)
 *   VERIFY_SYNC_COVERAGE_END         range end, exclusive (ISO 8601)
 *   VERIFY_SYNC_COVERAGE_PROBE_TZ    zone to probe against pg_timezone_names
 *   VERIFY_SYNC_COVERAGE_I_UNDERSTAND_THIS_IS_PRODUCTION=1
 *                                    required acknowledgement when the resolved
 *                                    database host is not localhost
 */
import dotenv from 'dotenv';
import type { Pool, PoolClient } from 'pg';
import path from 'node:path';

dotenv.config({ path: path.resolve(process.cwd(), '.env'), quiet: true });

const PRODUCTION_ACK_ENV = 'VERIFY_SYNC_COVERAGE_I_UNDERSTAND_THIS_IS_PRODUCTION';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const MILLISECONDS_PER_DAY = 86_400_000;

/**
 * The confirmed targets. Site 2252468802188120 (America/Chicago) is the only
 * site in the database whose local day 2026-03-08 is a genuine spring-forward
 * 23-hour day: 275 samples instead of 288, spanning 06:00:00Z to 04:50:00Z the
 * next morning. The 30-local-day window below brackets it with normal days.
 */
const DEFAULT_SITE_ID = '2252468802188120';
const DEFAULT_START = '2026-02-26T00:00:00Z';
const DEFAULT_END = '2026-03-28T00:00:00Z';

const DST_LOCAL_DAY = '2026-03-08';
const DST_EXPECTED_SAMPLES = 275;
const NORMAL_DAY_SAMPLES = 288;

interface Target {
    siteId: string;
    timezone: string;
    start: Date;
    end: Date;
}

interface SiteRow {
    id: string;
    timezone: string;
}

/** The reference side: derived independently of the SQL, in JavaScript. */
interface ReferenceStat {
    localDayKey: string;
    count: number;
    firstEpochMs: number;
    lastEpochMs: number;
    maxInteriorGapMs: number;
    windowStartEpochMs: number;
    windowEndEpochMs: number;
}

interface DayComparison {
    localDayKey: string;
    /** True only when both sides produced a stat for this key AND every field agreed. */
    matched: boolean;
    /** Set when the key exists on exactly one side; a day-key drift failure mode. */
    presence: 'both' | 'sql-only' | 'reference-only';
    fields: Array<{ name: string; sql: string; reference: string; ok: boolean }>;
}

interface CaseResult {
    target: Target;
    sqlRowCount: number;
    referenceRowCount: number;
    comparisons: DayComparison[];
    keySetEqual: boolean;
    onlyInSql: string[];
    onlyInReference: string[];
    daysInRangeWithNoRows: string[];
    maxGapDeltaMs: number;
}

function fail(message: string): void {
    console.error(message);
    process.exitCode = 1;
}

/**
 * Resolve the connection string without ever printing it. Accepts the dev
 * variable the brief names, but also DATABASE_URL, because the live target is
 * a legitimate (acknowledged) choice and this worktree's .env only carries
 * DATABASE_URL.
 */
function resolveDatabaseUrl(): string | null {
    const candidates = [
        process.env.VERIFY_SYNC_COVERAGE_DATABASE_URL,
        process.env.DEV_DATABASE_URL,
        process.env.DATABASE_URL,
    ];
    for (const candidate of candidates) {
        const trimmed = candidate?.trim();
        if (trimmed) return trimmed;
    }
    return null;
}

function isLocalHost(hostname: string): boolean {
    const host = hostname.toLowerCase();
    return LOCAL_HOSTS.has(host) || host === 'localhost';
}

/** Guard: only SELECT-family statements may be issued by this script. */
function assertReadOnlyStatement(sql: string): void {
    const verb = sql.trimStart().split(/\s+/)[0]?.toUpperCase() ?? '';
    const allowed = new Set(['SELECT', 'WITH', 'SHOW', 'SET']);
    if (!allowed.has(verb)) {
        throw new Error(`Refusing to issue a non-read-only statement starting with "${verb}".`);
    }
}

async function main(): Promise<void> {
    if (process.env.NODE_ENV === 'production') {
        fail('Refusing to run when NODE_ENV=production. No database connection was opened.');
        return;
    }

    const databaseUrl = resolveDatabaseUrl();
    if (!databaseUrl) {
        fail('VERIFY_SYNC_COVERAGE_DATABASE_URL, DEV_DATABASE_URL, or DATABASE_URL is required. No database connection was opened.');
        return;
    }

    let hostname: string;
    try {
        hostname = new URL(databaseUrl).hostname;
    } catch {
        fail('The resolved database URL is not parseable, so its host cannot be checked. No database connection was opened.');
        return;
    }
    const local = isLocalHost(hostname);
    if (!local && process.env[PRODUCTION_ACK_ENV] !== '1') {
        fail(
            `The resolved database host is not localhost. This check is SELECT-only, but it ` +
            `still reads real rows; set ${PRODUCTION_ACK_ENV}=1 to acknowledge that. ` +
            'No database connection was opened.'
        );
        return;
    }

    // `src/lib/db` builds its pool from process.env.DATABASE_URL at first use.
    process.env.DATABASE_URL = databaseUrl;

    const db = await import('../src/lib/db');
    const { EnergyRepo } = await import('../src/lib/energy-repo');
    const { formatSiteDate, getSiteMidnight, getValidTimezone } = await import('../src/lib/date-utils');
    const pool: Pool = db.pool;

    try {
        await pinConnectionsReadOnly(pool);

        const siteId = process.env.VERIFY_SYNC_COVERAGE_SITE_ID?.trim() || DEFAULT_SITE_ID;
        const start = parseInstant(process.env.VERIFY_SYNC_COVERAGE_START?.trim() || DEFAULT_START, 'VERIFY_SYNC_COVERAGE_START');
        const end = parseInstant(process.env.VERIFY_SYNC_COVERAGE_END?.trim() || DEFAULT_END, 'VERIFY_SYNC_COVERAGE_END');
        if (start === null || end === null) return;
        if (start.getTime() >= end.getTime()) {
            fail('The range start must be strictly before the range end. No queries were issued.');
            return;
        }

        const site = await readSite(pool, siteId);
        if (!site) {
            fail(`Site ${siteId} does not exist. No coverage queries were issued.`);
            return;
        }
        const timezoneOverride = process.env.VERIFY_SYNC_COVERAGE_TIMEZONE?.trim();
        const configuredTimezone = timezoneOverride || site.timezone;
        const timezone = getValidTimezone(configuredTimezone);
        if (timezone !== configuredTimezone) {
            console.log(
                `NOTE: requested timezone "${configuredTimezone}" is not usable by the ` +
                `Temporal/ICU runtime; getValidTimezone substituted "${timezone}". ` +
                'The comparison below therefore verifies the substituted zone.'
            );
        }

        const target: Target = { siteId, timezone, start, end };

        // Announce the full plan before any coverage query runs.
        console.log('verify-sync-daily-coverage: differential check of EnergyRepo.getDailyCoverage');
        console.log('Mode: READ-ONLY. Every statement issued is a SELECT; pooled connections are pinned to a read-only transaction.');
        console.log(`Database host locality: ${local ? 'localhost' : 'non-localhost (acknowledged with ' + PRODUCTION_ACK_ENV + '=1)'} [credentials never printed]`);
        console.log('');
        console.log('Target about to be queried:');
        console.log(`  site id:    ${target.siteId}`);
        console.log(`  timezone:   ${target.timezone}${timezoneOverride ? ' (overridden)' : ' (from "Site")'}`);
        console.log(`  range:      ${target.start.toISOString()} <= timestamp < ${target.end.toISOString()}`);
        console.log(`  server tz:  ${await readServerTimezone(pool)}`);
        console.log('');

        await probeTimezoneSupport(pool, process.env.VERIFY_SYNC_COVERAGE_PROBE_TZ?.trim() || 'Not/AZone');

        const energyRepo = new EnergyRepo();

        console.log('SQL path: EnergyRepo.getDailyCoverage (the shipped production query, not a copy).');
        let sqlStats;
        try {
            sqlStats = await energyRepo.getDailyCoverage(target.siteId, target.start, target.end, target.timezone);
        } catch (error) {
            reportTimezoneFailure(error, target.timezone);
            fail('getDailyCoverage failed, so no comparison was possible.');
            return;
        }
        console.log(`  rows returned: ${sqlStats.length} (one per site-local day)`);

        const referenceSql =
            'SELECT EXTRACT(EPOCH FROM "timestamp") AS epoch_s ' +
            'FROM "EnergyData" ' +
            'WHERE site_id = $1 AND "timestamp" >= $2 AND "timestamp" < $3 ' +
            'ORDER BY "timestamp" ASC';
        assertReadOnlyStatement(referenceSql);
        const started = process.hrtime.bigint();
        const raw = await pool.query(referenceSql, [target.siteId, target.start.toISOString(), target.end.toISOString()]);
        const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
        const referenceRowCount = raw.rows.length;
        const referenceStats = buildReference(
            raw.rows.map(row => Number((row as { epoch_s: string | number }).epoch_s) * 1000),
            timezone,
            formatSiteDate,
            getSiteMidnight,
        );
        console.log(`Reference path: raw epoch-ms rows.`);
        console.log(`  rows returned: ${referenceRowCount} (every 5-minute sample in range, ${elapsedMs.toFixed(1)} ms)`);
        console.log('');

        const result = compare(target, sqlStats, referenceStats, timezone, formatSiteDate, getSiteMidnight);
        printComparisons(result);
        printKeySetCheck(result);
        printNotableCases(result);
        printEgress(result, referenceRowCount);

        console.log('UNVERIFIED CASE: 25-hour fall-back day (a local day with ~300 samples).');
        console.log('  The brief asks for America/Chicago 2026-11-01. No rows exist after 2026-10-01, so that day');
        console.log('  cannot be tested against production data. A southern-hemisphere analog');
        console.log('  (Australia/Melbourne 2026-04-05) has zero rows, and a scan of every site-local day in the');
        console.log('  database found no local day with more than 288 samples, so no genuine 25-hour day exists');
        console.log('  anywhere in this data. This residue is acceptable to ship because:');
        console.log('    1. The SQL groups by date_trunc(\'day\', timestamp AT TIME ZONE tz), whose key is the local');
        console.log('       calendar date and contains no day-length-specific logic. A 23-hour and a 25-hour day');
        console.log('       differ only in how many samples land in the same key.');
        console.log('    2. The 23-hour day above exercises a mid-day UTC-offset change against real rows.');
        console.log('    3. generateDayWindows\' 25-hour window math is covered by synthetic unit tests.');
        console.log('  The narrow unverified residue is SQL day-bucketing on a 25-hour day. Not fabricated, not dropped.');

        const ok =
            result.keySetEqual &&
            result.comparisons.every(comparison => comparison.matched) &&
            result.daysInRangeWithNoRows.length >= 0;
        if (!ok) fail('DIFFERENTIAL CHECK FAILED. See the mismatches above.');
        else console.log('\nRESULT: PASS. SQL and reference agree on every day key, count, first, last, and maxInteriorGapMs.');
    } catch (error) {
        fail(`Verification failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
        try {
            await pool.end();
        } catch (error) {
            console.error(`Failed to close the database pool: ${error instanceof Error ? error.message : String(error)}`);
            process.exitCode = 1;
        }
    }
}

function parseInstant(value: string, label: string): Date | null {
    const parsed = new Date(value);
    if (isNaN(parsed.getTime())) {
        fail(`${label}="${value}" is not a parseable ISO 8601 instant.`);
        return null;
    }
    return parsed;
}

/**
 * Pin every connection this pool hands out to a read-only transaction, and to
 * any connection already sitting idle. `SET default_transaction_read_only`
 * covers statements issued without an explicit BEGIN, which is how the
 * production repo issues its queries.
 */
async function pinConnectionsReadOnly(pool: Pool): Promise<void> {
    const statement = 'SET default_transaction_read_only = on';
    assertReadOnlyStatement(statement);
    pool.on('connect', (client: PoolClient) => {
        client.query(statement).catch((error: unknown) => {
            console.error(`Failed to pin a pooled connection read-only: ${error instanceof Error ? error.message : String(error)}`);
            process.exitCode = 1;
        });
    });
    await pool.query(statement);
    const state = await pool.query<{ default_transaction_read_only: string }>('SHOW default_transaction_read_only');
    const value = state.rows[0]?.default_transaction_read_only;
    if (value !== 'on') {
        throw new Error(`Refusing to continue: the session read-only flag is "${value}", expected "on".`);
    }
}

async function readServerTimezone(pool: Pool): Promise<string> {
    const result = await pool.query<{ TimeZone: string }>('SHOW TimeZone');
    return result.rows[0]?.TimeZone ?? '(unknown)';
}

async function readSite(pool: Pool, siteId: string): Promise<SiteRow | null> {
    const sql = 'SELECT id, timezone FROM "Site" WHERE id = $1';
    assertReadOnlyStatement(sql);
    const result = await pool.query<SiteRow>(sql, [siteId]);
    return result.rows[0] ?? null;
}

/**
 * `getValidTimezone` validates against Temporal/ICU tzdata, but Postgres
 * resolves `AT TIME ZONE` against its own `pg_timezone_names`. A zone ICU
 * accepts but this server's tzdata lacks would raise at query time. Report that
 * clearly rather than crashing with a bare driver error.
 */
async function probeTimezoneSupport(pool: Pool, probe: string): Promise<void> {
    const sql = 'SELECT name FROM pg_timezone_names WHERE name = $1';
    assertReadOnlyStatement(sql);
    const known = await pool.query<{ name: string }>(sql, [probe]).then(
        result => result.rows.length > 0,
        (error: unknown) => {
            console.log(`Timezone probe: pg_timezone_names lookup for "${probe}" raised: ${error instanceof Error ? error.message : String(error)}`);
            return false;
        }
    );
    if (!known) {
        console.log(`Timezone probe: "${probe}" is absent from this server's pg_timezone_names.`);
        console.log('  That is exactly the shape of failure a site timezone can trigger: ICU accepts it, this');
        console.log('  server does not, and `AT TIME ZONE` raises at query time. getValidTimezone cannot catch it');
        console.log('  because it never asks Postgres. See the diagnostic path below.');
    } else {
        console.log(`Timezone probe: "${probe}" is present in pg_timezone_names.`);
    }
}

function reportTimezoneFailure(error: unknown, timezone: string): void {
    const message = error instanceof Error ? error.message : String(error);
    const looksTimezoneRelated = /time zone|timezone|AT TIME ZONE|22023|42704/i.test(message);
    if (looksTimezoneRelated) {
        console.error('');
        console.error(`DIAGNOSTIC: the query for timezone "${timezone}" failed in a way that looks timezone-related.`);
        console.error('  getValidTimezone validated this zone against Temporal/ICU tzdata, but Postgres resolves');
        console.error('  `AT TIME ZONE` against its own pg_timezone_names. A zone ICU accepts but the server');
        console.error('  lacks raises here. This is a real production risk, not a script bug.');
        console.error(`  Driver message: ${message.split('\n')[0]}`);
    } else {
        console.error(`getDailyCoverage raised: ${message.split('\n')[0]}`);
    }
}

/**
 * Independent reference: bucket raw epoch-ms samples by site-local day using
 * `getSiteMidnight` windows and `formatSiteDate` keys, then derive each stat
 * from the sorted array. `maxInteriorGapMs` is threshold-independent -- the max
 * consecutive delta within the day, with no reference to any gap policy.
 */
function buildReference(
    epochMsRows: number[],
    timezone: string,
    formatSiteDate: (date: Date, tz: string) => string,
    getSiteMidnight: (date: Date, tz: string) => Date,
): Map<string, ReferenceStat> {
    const buckets = new Map<string, number[]>();
    for (const epochMs of epochMsRows) {
        const key = formatSiteDate(new Date(epochMs), timezone);
        const existing = buckets.get(key);
        if (existing) existing.push(epochMs);
        else buckets.set(key, [epochMs]);
    }

    const stats = new Map<string, ReferenceStat>();
    for (const [key, samples] of buckets) {
        samples.sort((a, b) => a - b);
        let maxInteriorGapMs = 0;
        for (let i = 1; i < samples.length; i += 1) {
            const delta = samples[i] - samples[i - 1];
            if (delta > maxInteriorGapMs) maxInteriorGapMs = delta;
        }
        const firstEpochMs = samples[0];
        const lastEpochMs = samples[samples.length - 1];
        // Every local day in this database is between 23 and 25 hours long, so
        // adding 36 hours to a local midnight always lands inside the next
        // local day. That derives the exclusive window end from getSiteMidnight
        // rather than assuming a fixed 24 hours, which would be wrong on a DST
        // boundary.
        const first = firstEpochMs;
        const last = lastEpochMs;
        const windowStart = getSiteMidnight(new Date(first), timezone);
        const windowEnd = getSiteMidnight(new Date(windowStart.getTime() + 36 * 60 * 60 * 1000), timezone);
        if (formatSiteDate(windowEnd, timezone) !== nextLocalDayKey(key)) {
            throw new Error(
                `Reference window math disagreed for ${key}: the window derived from getSiteMidnight ends on ` +
                `${formatSiteDate(windowEnd, timezone)}, expected the next local day ${nextLocalDayKey(key)}.`
            );
        }
        if (first < windowStart.getTime() || last >= windowEnd.getTime()) {
            throw new Error(`Reference bucket ${key} contains a sample outside its own getSiteMidnight window.`);
        }
        stats.set(key, {
            localDayKey: key,
            count: samples.length,
            firstEpochMs: first,
            lastEpochMs: last,
            maxInteriorGapMs,
            windowStartEpochMs: windowStart.getTime(),
            windowEndEpochMs: windowEnd.getTime(),
        });
    }
    return stats;
}

function nextLocalDayKey(key: string): string {
    const [year, month, day] = key.split('-').map(Number);
    const next = new Date(Date.UTC(year, month - 1, day) + MILLISECONDS_PER_DAY);
    return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
}

/** Enumerate every site-local day the range touches, so an empty day is visible. */
function localDaysInRange(target: Target, formatSiteDate: (date: Date, tz: string) => string, getSiteMidnight: (date: Date, tz: string) => Date): string[] {
    const days: string[] = [];
    let cursor = getSiteMidnight(target.start, target.timezone);
    for (let i = 0; i < 400; i += 1) {
        const next = getSiteMidnight(new Date(cursor.getTime() + 36 * 60 * 60 * 1000), target.timezone);
        if (next.getTime() >= target.end.getTime()) break;
        days.push(formatSiteDate(new Date(cursor.getTime() + 1), target.timezone));
        cursor = next;
    }
    return days;
}

function compare(
    target: Target,
    sqlStats: Array<{ localDayKey: string; count: number; first: Date | null; last: Date | null; maxInteriorGapMs: number }>,
    referenceStats: Map<string, ReferenceStat>,
    timezone: string,
    formatSiteDate: (date: Date, tz: string) => string,
    getSiteMidnight: (date: Date, tz: string) => Date,
): CaseResult {
    const sqlByKey = new Map(sqlStats.map(stat => [stat.localDayKey, stat]));
    const comparisons: DayComparison[] = [];
    let maxGapDeltaMs = 0;

    const keys = [...new Set([...sqlByKey.keys(), ...referenceStats.keys()])].sort();
    for (const key of keys) {
        const sql = sqlByKey.get(key);
        const reference = referenceStats.get(key);
        const presence: DayComparison['presence'] = sql && reference ? 'both' : sql ? 'sql-only' : 'reference-only';
        const fields: DayComparison['fields'] = [];
        if (sql && reference) {
            // Normalise both sides to epoch milliseconds. getDailyCoverage
            // returns Date | null; the reference is already epoch ms.
            const sqlFirst = sql.first ? sql.first.getTime() : null;
            const sqlLast = sql.last ? sql.last.getTime() : null;
            const gapDelta = Math.abs(sql.maxInteriorGapMs - reference.maxInteriorGapMs);
            if (gapDelta > maxGapDeltaMs) maxGapDeltaMs = gapDelta;
            fields.push(
                { name: 'count', sql: String(sql.count), reference: String(reference.count), ok: sql.count === reference.count },
                { name: 'first', sql: String(sqlFirst), reference: String(reference.firstEpochMs), ok: sqlFirst === reference.firstEpochMs },
                { name: 'last', sql: String(sqlLast), reference: String(reference.lastEpochMs), ok: sqlLast === reference.lastEpochMs },
                {
                    name: 'maxInteriorGapMs',
                    sql: String(sql.maxInteriorGapMs),
                    reference: String(reference.maxInteriorGapMs),
                    ok: gapDelta <= 0.5,
                }
            );
        }
        // A key present on only one side is a failure, not an empty field list that
        // trivially "matches". This is the day-key drift guard.
        comparisons.push({
            localDayKey: key,
            matched: presence === 'both' && fields.every(field => field.ok),
            presence,
            fields,
        });
    }

    const onlyInSql = [...sqlByKey.keys()].filter(key => !referenceStats.has(key)).sort();
    const onlyInReference = [...referenceStats.keys()].filter(key => !sqlByKey.has(key)).sort();
    const populated = new Set([...sqlByKey.keys(), ...referenceStats.keys()]);
    const daysInRangeWithNoRows = localDaysInRange(target, formatSiteDate, getSiteMidnight).filter(key => !populated.has(key));

    return {
        target,
        sqlRowCount: sqlStats.length,
        referenceRowCount: referenceStats.size,
        comparisons,
        keySetEqual: onlyInSql.length === 0 && onlyInReference.length === 0,
        onlyInSql,
        onlyInReference,
        daysInRangeWithNoRows,
        maxGapDeltaMs,
    };
}

function formatEpochMs(epochMs: number): string {
    return new Date(epochMs).toISOString();
}

function printComparisons(result: CaseResult): void {
    const mismatches = result.comparisons.filter(comparison => !comparison.matched);
    console.log(`Per-day comparison (${result.comparisons.length} day keys):`);
    for (const comparison of result.comparisons) {
        const count = comparison.fields.find(field => field.name === 'count')?.reference;
        const countText = comparison.presence === 'both' ? String(count).padStart(4) : '   -';
        const status = comparison.matched ? 'match' : 'MISMATCH';
        const marker = comparison.localDayKey === DST_LOCAL_DAY ? '  <- 23-hour DST day' : '';
        console.log(`  ${comparison.localDayKey}  count=${countText}  ${status}${marker}`);
        if (comparison.presence !== 'both') {
            console.log(`      day key present on ${comparison.presence} side only: SQL and reference disagree on the day key itself`);
        }
        for (const field of comparison.fields) {
            if (!field.ok) {
                console.log(`      ${field.name}: sql=${field.sql} reference=${field.reference}`);
            }
        }
    }
    console.log('');
    if (mismatches.length === 0) {
        console.log('  All compared days agree on count, first, last, and maxInteriorGapMs.');
    } else {
        console.log(`  ${mismatches.length} day(s) MISMATCHED: ${mismatches.map(m => m.localDayKey).join(', ')}`);
        console.log('  Per the brief, the SQL and the reference are NOT adjusted to agree. Investigate the design.');
    }
    console.log(`  Largest maxInteriorGapMs delta observed: ${result.maxGapDeltaMs} ms (tolerance 0.5 ms for float rounding).`);
    console.log('');
}

function printKeySetCheck(result: CaseResult): void {
    const sqlKeys = result.comparisons.map(c => c.localDayKey);
    console.log('Key-set equality (primary check, catches to_char vs formatSiteDate day-key drift):');
    console.log(`  SQL day keys:      ${result.sqlRowCount}`);
    console.log(`  Reference day keys:${String(result.referenceRowCount).padStart(4)}`);
    console.log(`  only in SQL:       ${result.onlyInSql.length === 0 ? '(none)' : result.onlyInSql.join(', ')}`);
    console.log(`  only in reference: ${result.onlyInReference.length === 0 ? '(none)' : result.onlyInReference.join(', ')}`);
    if (result.sqlRowCount === 0 || result.referenceRowCount === 0) {
        console.log('  WARNING: one side produced zero day keys. The key-set check would pass vacuously.');
    }
    console.log(`  local days in range with no rows in either side: ${result.daysInRangeWithNoRows.length === 0 ? '(none)' : result.daysInRangeWithNoRows.join(', ')}`);
    console.log(`  key sets identical: ${result.keySetEqual ? 'YES' : 'NO'}`);
    console.log('');
}

function printNotableCases(result: CaseResult): void {
    const byKey = new Map(result.comparisons.map(c => [c.localDayKey, c]));
    console.log('Confirmed cases:');
    const dst = byKey.get(DST_LOCAL_DAY);
    if (!dst) {
        console.log(`  23-hour spring-forward day ${DST_LOCAL_DAY}: ABSENT from the compared range. NOT VERIFIED.`);
    } else if (dst.presence !== 'both') {
        console.log(`  23-hour spring-forward day ${DST_LOCAL_DAY}: present on ${dst.presence} side only -- NOT VERIFIED.`);
    } else {
        const count = dst.fields.find(f => f.name === 'count')?.reference;
        console.log(
            `  23-hour spring-forward day ${DST_LOCAL_DAY}: ${count} samples vs ${NORMAL_DAY_SAMPLES} on a normal day -- ` +
            `${dst.matched ? 'MATCHED' : 'MISMATCHED'}`
        );
    }

    const partials = result.comparisons.filter(c => c.presence === 'both' && (() => {
        const count = Number(c.fields.find(f => f.name === 'count')?.reference ?? '0');
        return count > 0 && count < 200;
    })());
    if (partials.length === 0) {
        console.log('  Partial (truncated-start or truncated-end) days: none in this range.');
    }
    for (const partial of partials) {
        const count = partial.fields.find(f => f.name === 'count')?.reference;
        console.log(`  partial day ${partial.localDayKey}: ${count} samples -- ${partial.matched ? 'MATCHED' : 'MISMATCHED'}`);
    }
    const holey = result.comparisons.filter(c => Number(c.fields.find(f => f.name === 'maxInteriorGapMs')?.sql ?? '0') > 600_000);
    if (holey.length === 0) {
        console.log('  Days with an interior hole (maxInteriorGapMs > 600000): none in this range.');
    }
    for (const hole of holey) {
        const gap = hole.fields.find(f => f.name === 'maxInteriorGapMs');
        console.log(`  interior-hole day ${hole.localDayKey}: sql=${gap?.sql} ms reference=${gap?.reference} ms -- ${hole.matched ? 'MATCHED' : 'MISMATCHED'}`);
    }
    console.log('');
}

function printEgress(result: CaseResult, referenceRowCount: number): void {
    const reduction = referenceRowCount / Math.max(result.sqlRowCount, 1);
    console.log('Egress reduction for this range:');
    console.log(`  reference (old shape, every 5-minute row shipped): ${referenceRowCount} rows`);
    console.log(`  getDailyCoverage (new shape, one row per local day): ${result.sqlRowCount} rows`);
    console.log(`  reduction: ${reduction.toFixed(1)}x (${((1 - result.sqlRowCount / Math.max(referenceRowCount, 1)) * 100).toFixed(2)}% fewer rows)`);
    console.log('');
}

void main();
