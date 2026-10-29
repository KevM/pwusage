import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const socket = process.env.DEV_COPY_TEST_SOCKET;
const safeSocket = socket && /^\/(?:private\/)?tmp\/dev-copy-pg-[a-zA-Z0-9]+$/.test(socket);
if (socket && !safeSocket) throw new Error('Dev copy script tests require a disposable private local socket');
const PORT = 55442;

// The parts of the real schema the dev-only scripts touch.
const SCHEMA = `
CREATE TABLE public."Site" (id text PRIMARY KEY, last_live_refresh_at bigint DEFAULT 0);
CREATE TABLE public."Tariff" (id serial PRIMARY KEY);
CREATE TABLE public."TariffSchedule" (id serial PRIMARY KEY);
INSERT INTO public."Tariff" VALUES (1);
INSERT INTO public."TariffSchedule" VALUES (1);
CREATE TABLE public."MobileLoginHandoff" (attempt_id uuid PRIMARY KEY, user_id text NOT NULL);
CREATE TABLE public."TrmnlInstallation" (uuid text PRIMARY KEY, access_token text, refresh_token text);
INSERT INTO public."Site" VALUES ('s1');
INSERT INTO public."MobileLoginHandoff" VALUES ('00000000-0000-0000-0000-000000000001', 'u1');
INSERT INTO public."TrmnlInstallation" VALUES ('t1', 'inbound-token', 'unused-refresh-token');
CREATE TABLE public."User" (id text PRIMARY KEY, email text, access_token text, refresh_token text, auth_status text);
INSERT INTO public."User" VALUES ('u1', 'owner@example.com', 'prod-access', 'prod-refresh', 'active');
CREATE TABLE public."BatteryHoldActivity" (id serial PRIMARY KEY, push_token text);
INSERT INTO public."BatteryHoldActivity" (push_token) VALUES ('device-token');
CREATE TABLE public."EnergyDayArchive" (
    site_id text NOT NULL REFERENCES public."Site"(id) ON DELETE CASCADE,
    day_start timestamptz NOT NULL,
    day_end timestamptz NOT NULL,
    sample_count integer NOT NULL,
    revision text NOT NULL DEFAULT 'r1',
    PRIMARY KEY (site_id, day_start),
    UNIQUE (site_id, day_start, revision)
);
CREATE TABLE public."EnergyDaySummary" (
    site_id text NOT NULL,
    day_start timestamptz NOT NULL,
    revision text NOT NULL,
    tariff_id integer NOT NULL REFERENCES public."Tariff"(id),
    tariff_schedule_id integer REFERENCES public."TariffSchedule"(id),
    FOREIGN KEY (site_id, day_start, revision) REFERENCES public."EnergyDayArchive"(site_id, day_start, revision) ON DELETE CASCADE
);
INSERT INTO public."EnergyDayArchive" (site_id, day_start, day_end, sample_count) VALUES
    ('s1', date_trunc('day', now()) - interval '2 days', date_trunc('day', now()) - interval '1 day', 288);
`;
const ARCHIVE_HEADER = 'site_id,day_start,day_end,sample_count,revision\n';
const SUMMARY_HEADER = 'site_id,day_start,revision,tariff_id,tariff_schedule_id\n';

const MARK_DEV = `CREATE SCHEMA pwusage_env; CREATE TABLE pwusage_env.environment (name text PRIMARY KEY); INSERT INTO pwusage_env.environment VALUES ('dev');`;
const DEV_SCRIPTS = ['scripts/assert-dev-database.sql', 'scripts/load-dev-energy-data.sql', 'scripts/sanitize-dev-copy.sql', 'scripts/prune-dev-copy.sql'];
// Harrison, always part of the dev day-record subset (scripts/export-dev-energy-data.sql).
const PINNED_SITE = '2252268092126997';

// Each case loads and dumps real data through psql; shared CI runners can exceed
// Vitest's 5s unit-test default even when the database operations succeed.
describe.skipIf(!safeSocket)('dev-only SQL scripts against isolated PostgreSQL', { timeout: 30000 }, () => {
    let admin: Pool;
    let target: Pool | undefined;
    let caseNumber = 0;
    let database = '';

    beforeAll(() => { admin = new Pool({ host: socket, port: PORT, user: process.env.USER, database: 'postgres', max: 2 }); });
    afterAll(async () => { await admin?.end(); });
    beforeEach(async () => {
        caseNumber += 1;
        database = `dev_copy_case_${caseNumber}`;
        await admin.query(`CREATE DATABASE ${database}`);
        target = new Pool({ host: socket, port: PORT, user: process.env.USER, database, max: 2 });
        await target.query(SCHEMA);
    });
    let work = '';
    beforeEach(async () => { work = await mkdtemp(join(tmpdir(), 'pwusage-dev-copy-')); });
    afterEach(async () => { await target?.end(); await rm(work, { recursive: true }); });
    const script = (file: string) => resolve(file);
    // The day-record CSVs the export writes, in the load's working directory.
    const dayRecordFiles = async (archive = '', summary = '') => {
        await writeFile(join(work, 'dev-day-archive.csv'), ARCHIVE_HEADER + archive);
        await writeFile(join(work, 'dev-day-summary.csv'), SUMMARY_HEADER + summary);
    };

    const targetUrl = () => `postgresql:///${database}?host=${encodeURIComponent(socket!)}&port=${PORT}`;
    const rows = async (sql: string) => (await target!.query(sql)).rows;

    // Deliberately without ON_ERROR_STOP: the guard must fail closed on its own.
    async function psql(...files: string[]) {
        const args = [targetUrl(), '-X', '-q', ...files.flatMap((file) => ['-f', file])];
        try {
            const result = await run('psql', args);
            return { code: 0, out: result.stdout + result.stderr };
        } catch (error) {
            const failed = error as { code: number; stdout: string; stderr: string };
            return { code: failed.code, out: failed.stdout + failed.stderr };
        }
    }

    // Runs where the day-record CSVs are (empty unless a test wrote them).
    async function psqlInWork(...args: string[]) {
        await readFile(join(work, 'dev-day-archive.csv')).catch(() => dayRecordFiles());
        const absolute = args.map((arg) => arg.startsWith('scripts/') ? script(arg) : arg);
        return new Promise<{ code: number; out: string }>((resolve) => {
            const child = spawn('psql', [targetUrl(), '-X', '-q', ...absolute], { cwd: work });
            let out = '';
            child.stdout.on('data', (chunk) => { out += chunk; });
            child.stderr.on('data', (chunk) => { out += chunk; });
            child.on('close', (code) => resolve({ code: code ?? 1, out }));
            child.stdin.end();
        });
    }

    const snapshot = async () => ({
        energy: await rows(`SELECT count(*)::int AS n FROM public."EnergyDayArchive"`),
        handoffs: await rows(`SELECT count(*)::int AS n FROM public."MobileLoginHandoff"`),
        trmnl: await rows(`SELECT access_token, refresh_token FROM public."TrmnlInstallation"`),
        activities: await rows(`SELECT count(*)::int AS n FROM public."BatteryHoldActivity"`),
        users: await rows(`SELECT access_token, refresh_token FROM public."User"`),
    });

    it.each([
        ['has no marker', ''],
        ['has an empty marker table', 'CREATE SCHEMA pwusage_env; CREATE TABLE pwusage_env.environment (name text PRIMARY KEY);'],
        ['is marked as another environment', `CREATE SCHEMA pwusage_env; CREATE TABLE pwusage_env.environment (name text PRIMARY KEY); INSERT INTO pwusage_env.environment VALUES ('prod');`],
    ])('every dev-only script refuses a database that %s, and changes nothing', async (_label, marker) => {
        if (marker) await target!.query(marker);
        const before = await snapshot();
        for (const script of DEV_SCRIPTS) {
            const result = await psql(script);
            expect(result.code, script).not.toBe(0);
            expect(result.out, script).toContain('not marked as a dev database');
        }
        expect(await snapshot()).toEqual(before);
    });

    it('stops a following destructive file when the guard refuses', async () => {
        const result = await psql('scripts/assert-dev-database.sql', 'scripts/test-fixtures/drop-public.sql');
        expect(result.code).not.toBe(0);
        expect(await rows(`SELECT count(*)::int AS n FROM public."Site"`)).toEqual([{ n: 1 }]);
    });

    it('lets a marked dev database through the guard', async () => {
        await target!.query(MARK_DEV);
        const result = await psql('scripts/assert-dev-database.sql');
        expect(result.out).toBe('');
        expect(result.code).toBe(0);
    });

    it('sanitizes a marked dev copy, keeping what beta relies on', async () => {
        await target!.query(MARK_DEV);
        const result = await psql('scripts/sanitize-dev-copy.sql');
        expect(result.code, result.out).toBe(0);
        expect(await rows(`SELECT count(*)::int AS n FROM public."MobileLoginHandoff"`)).toEqual([{ n: 0 }]);
        expect(await rows(`SELECT access_token, refresh_token FROM public."TrmnlInstallation"`))
            .toEqual([{ access_token: 'inbound-token', refresh_token: null }]);
        expect(await rows(`SELECT count(*)::int AS n FROM public."EnergyDayArchive"`)).toEqual([{ n: 1 }]);
        expect(await rows(`SELECT count(*)::int AS n FROM public."BatteryHoldActivity"`)).toEqual([{ n: 0 }]);
        // Prod's single-use Tesla grant must never be refreshable from beta.
        expect(await rows(`SELECT email, access_token, refresh_token, auth_status FROM public."User"`))
            .toEqual([{ email: 'owner@example.com', access_token: null, refresh_token: null, auth_status: 'revoked' }]);
        // Idempotent.
        expect((await psql('scripts/sanitize-dev-copy.sql')).code).toBe(0);
    });

    it('sanitizes in the same transaction as the data restore', async () => {
        await target!.query(MARK_DEV);
        const result = await run('psql', [targetUrl(), '-X', '-q', '--single-transaction', '-v', 'ON_ERROR_STOP=1',
            '-c', `INSERT INTO public."MobileLoginHandoff" VALUES ('00000000-0000-0000-0000-000000000002', 'u2')`,
            '-f', 'scripts/sanitize-dev-copy.sql']);
        expect(result.stderr).not.toContain('ERROR');
        expect(await rows(`SELECT count(*)::int AS n FROM public."MobileLoginHandoff"`)).toEqual([{ n: 0 }]);
    });

    it('skips rules for tables that do not exist yet', async () => {
        await target!.query(`${MARK_DEV} DROP TABLE public."MobileLoginHandoff"; DROP TABLE public."TrmnlInstallation"; DROP TABLE public."BatteryHoldActivity"; DROP TABLE public."User"; DROP TABLE public."EnergyDaySummary"; DROP TABLE public."EnergyDayArchive";`);
        expect((await psql('scripts/sanitize-dev-copy.sql')).code).toBe(0);
        expect((await psql('scripts/prune-dev-copy.sql')).code).toBe(0);
    });

    it('exports day records and their summaries for the 5 most recently live sites plus Harrison, in one snapshot', async () => {
        await target!.query(`
            DELETE FROM public."EnergyDayArchive";
            INSERT INTO public."Site" (id, last_live_refresh_at) SELECT 'live' || n, 1000 + n FROM generate_series(1, 6) AS n;
            INSERT INTO public."Site" (id, last_live_refresh_at) VALUES ('${PINNED_SITE}', 0);
            INSERT INTO public."EnergyDayArchive" (site_id, day_start, day_end, sample_count) VALUES
                ('live6', date_trunc('day', now()) - interval '2 days', date_trunc('day', now()) - interval '1 day', 288),
                ('live6', date_trunc('day', now()) - interval '50 days', date_trunc('day', now()) - interval '49 days', 288),
                ('live1', date_trunc('day', now()) - interval '2 days', date_trunc('day', now()) - interval '1 day', 288),
                ('${PINNED_SITE}', date_trunc('day', now()) - interval '2 days', date_trunc('day', now()) - interval '1 day', 288);
            INSERT INTO public."EnergyDaySummary" SELECT site_id, day_start, revision, 1, 1 FROM public."EnergyDayArchive";`);
        const result = await run('psql', [targetUrl(), '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', script('scripts/export-dev-energy-data.sql')], { cwd: work });
        expect(result.stdout).toBe('');
        const csvSites = async (file: string) => (await readFile(join(work, file), 'utf8')).trim().split('\n').slice(1).map((line) => line.split(',')[0]);
        // live1 is not among the 5 most recently live; live6's 50-day-old record is outside the window.
        expect(await csvSites('dev-day-archive.csv')).toEqual([PINNED_SITE, 'live6']);
        expect(await csvSites('dev-day-summary.csv')).toEqual([PINNED_SITE, 'live6']);
        expect((await readFile(join(work, 'dev-day-archive.csv'), 'utf8')).split('\n')[0] + '\n').toBe(ARCHIVE_HEADER);
    });

    it('loads day records and summaries, dropping whole days whose site or tariff was deleted before the dump', async () => {
        await target!.query(`${MARK_DEV} DELETE FROM public."EnergyDayArchive"; INSERT INTO public."Site" (id, last_live_refresh_at) VALUES ('s2', 600);`);
        await dayRecordFiles(
            's1,2026-10-01 00:00:00+00,2026-10-02 00:00:00+00,288,r1\n'
            + 'gone,2026-10-01 00:00:00+00,2026-10-02 00:00:00+00,288,r1\n'
            + 's1,2026-10-02 00:00:00+00,2026-10-03 00:00:00+00,288,r1\n'
            + 's1,2026-10-03 00:00:00+00,2026-10-04 00:00:00+00,288,r1\n',
            's1,2026-10-01 00:00:00+00,r1,1,1\n'
            + 'gone,2026-10-01 00:00:00+00,r1,1,1\n'
            + 's1,2026-10-02 00:00:00+00,r1,1,1\n'
            + 's1,2026-10-02 00:00:00+00,r1,99,1\n'
            + 's1,2026-10-03 00:00:00+00,r1,1,99\n');
        const result = await psqlInWork('--single-transaction', '-v', 'ON_ERROR_STOP=1', '-f', 'scripts/load-dev-energy-data.sql');
        expect(result.code, result.out).toBe(0);
        // Kept: 10-01. Dropped with their summaries: the deleted site's day, and the days naming a deleted tariff or schedule.
        expect(await rows(`SELECT site_id, to_char(day_start AT TIME ZONE 'UTC', 'MM-DD') AS day FROM public."EnergyDayArchive"`))
            .toEqual([{ site_id: 's1', day: '10-01' }]);
        expect(await rows(`SELECT site_id, to_char(day_start AT TIME ZONE 'UTC', 'MM-DD') AS day FROM public."EnergyDaySummary"`))
            .toEqual([{ site_id: 's1', day: '10-01' }]);
        // Sites left without day records look idle, so beta's crons skip them.
        expect(await rows(`SELECT id, last_live_refresh_at::int AS t FROM public."Site" ORDER BY id`))
            .toEqual([{ id: 's1', t: 0 }, { id: 's2', t: 0 }]);
    });

    it('refuses day-record files whose columns do not match the dev tables', async () => {
        await target!.query(`${MARK_DEV} DELETE FROM public."EnergyDayArchive";`);
        await writeFile(join(work, 'dev-day-archive.csv'), 'site_id,day_start\n');
        await writeFile(join(work, 'dev-day-summary.csv'), SUMMARY_HEADER);
        const result = await psqlInWork('--single-transaction', '-v', 'ON_ERROR_STOP=1', '-f', 'scripts/load-dev-energy-data.sql');
        expect(result.code).not.toBe(0);
    });

    it('prunes day records older than 45 days on a marked dev copy, with their summaries', async () => {
        await target!.query(`${MARK_DEV} DELETE FROM public."EnergyDayArchive";
            INSERT INTO public."EnergyDayArchive" (site_id, day_start, day_end, sample_count) VALUES
                ('s1', date_trunc('day', now()) - interval '50 days', date_trunc('day', now()) - interval '49 days', 288),
                ('s1', date_trunc('day', now()) - interval '2 days', date_trunc('day', now()) - interval '1 day', 288);
            INSERT INTO public."EnergyDaySummary" SELECT site_id, day_start, revision, 1, 1 FROM public."EnergyDayArchive";`);
        const result = await psql('scripts/prune-dev-copy.sql');
        expect(result.code, result.out).toBe(0);
        expect(await rows(`SELECT count(*)::int AS n FROM public."EnergyDayArchive"`)).toEqual([{ n: 1 }]);
        expect(await rows(`SELECT count(*)::int AS n FROM public."EnergyDaySummary"`)).toEqual([{ n: 1 }]);
        // The marker survives; the scripts never touch it.
        expect(await rows(`SELECT name FROM pwusage_env.environment`)).toEqual([{ name: 'dev' }]);
    });
});
