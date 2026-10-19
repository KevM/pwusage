import { execFile, spawn } from 'node:child_process';
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
CREATE TABLE public."EnergyData" (
    id serial PRIMARY KEY,
    "timestamp" timestamptz NOT NULL,
    site_id text NOT NULL REFERENCES public."Site"(id) ON DELETE CASCADE,
    load_power double precision
);
CREATE TABLE public."MobileLoginHandoff" (attempt_id uuid PRIMARY KEY, user_id text NOT NULL);
CREATE TABLE public."TrmnlInstallation" (uuid text PRIMARY KEY, access_token text, refresh_token text);
INSERT INTO public."Site" VALUES ('s1');
INSERT INTO public."EnergyData" ("timestamp", site_id, load_power) VALUES
    (now() - interval '400 days', 's1', 1),
    (now() - interval '46 days', 's1', 2),
    (now() - interval '44 days', 's1', 3),
    (now() - interval '1 hour', 's1', 4);
INSERT INTO public."MobileLoginHandoff" VALUES ('00000000-0000-0000-0000-000000000001', 'u1');
INSERT INTO public."TrmnlInstallation" VALUES ('t1', 'inbound-token', 'unused-refresh-token');
CREATE TABLE public."BatteryHoldActivity" (id serial PRIMARY KEY, push_token text);
INSERT INTO public."BatteryHoldActivity" (push_token) VALUES ('device-token');
CREATE TABLE public."EnergyDayArchive" (
    site_id text NOT NULL REFERENCES public."Site"(id) ON DELETE CASCADE,
    day_start timestamptz NOT NULL,
    day_end timestamptz NOT NULL,
    sample_count integer NOT NULL,
    raw_pruned boolean NOT NULL DEFAULT false,
    PRIMARY KEY (site_id, day_start)
);
`;

const MARK_DEV = `CREATE SCHEMA pwusage_env; CREATE TABLE pwusage_env.environment (name text PRIMARY KEY); INSERT INTO pwusage_env.environment VALUES ('dev');`;
const DEV_SCRIPTS = ['scripts/assert-dev-database.sql', 'scripts/load-dev-energy-data.sql', 'scripts/sanitize-dev-copy.sql', 'scripts/prune-dev-copy.sql'];
// Harrison, always part of the dev EnergyData subset (scripts/export-dev-energy-data.sql).
const PINNED_SITE = '2252268092126997';

describe.skipIf(!safeSocket)('dev-only SQL scripts against isolated PostgreSQL', () => {
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
    afterEach(async () => { await target?.end(); });

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

    // Feeds stdin, as CI redirects the exported CSV into the restore's psql.
    function psqlWithInput(input: string, ...args: string[]) {
        return new Promise<{ code: number; out: string }>((resolve) => {
            const child = spawn('psql', [targetUrl(), '-X', '-q', ...args]);
            let out = '';
            child.stdout.on('data', (chunk) => { out += chunk; });
            child.stderr.on('data', (chunk) => { out += chunk; });
            child.on('close', (code) => resolve({ code: code ?? 1, out }));
            child.stdin.end(input);
        });
    }

    const snapshot = async () => ({
        energy: await rows(`SELECT count(*)::int AS n FROM public."EnergyData"`),
        handoffs: await rows(`SELECT count(*)::int AS n FROM public."MobileLoginHandoff"`),
        trmnl: await rows(`SELECT access_token, refresh_token FROM public."TrmnlInstallation"`),
        activities: await rows(`SELECT count(*)::int AS n FROM public."BatteryHoldActivity"`),
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
        expect(await rows(`SELECT count(*)::int AS n FROM public."EnergyData"`)).toEqual([{ n: 4 }]);
        expect(await rows(`SELECT count(*)::int AS n FROM public."BatteryHoldActivity"`)).toEqual([{ n: 0 }]);
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
        await target!.query(`${MARK_DEV} DROP TABLE public."MobileLoginHandoff"; DROP TABLE public."TrmnlInstallation"; DROP TABLE public."EnergyData"; DROP TABLE public."BatteryHoldActivity"; DROP TABLE public."EnergyDayArchive";`);
        expect((await psql('scripts/sanitize-dev-copy.sql')).code).toBe(0);
        expect((await psql('scripts/prune-dev-copy.sql')).code).toBe(0);
    });

    it('exports the last 45 days of EnergyData for the 5 most recently live sites plus Harrison only', async () => {
        // s1 (from SCHEMA) was never live; seven sites were, at increasing times.
        await target!.query(`
            INSERT INTO public."Site" (id, last_live_refresh_at)
                SELECT 'live' || n, 1000 + n FROM generate_series(1, 7) AS n;
            INSERT INTO public."Site" (id, last_live_refresh_at) VALUES ('${PINNED_SITE}', 0);
            INSERT INTO public."EnergyData" ("timestamp", site_id, load_power)
                SELECT now() - interval '1 hour', id, 10 FROM public."Site" WHERE id <> 's1';
            INSERT INTO public."EnergyData" ("timestamp", site_id, load_power)
                SELECT now() - interval '46 days', id, 20 FROM public."Site" WHERE id <> 's1';`);
        // Read-only and unguarded: it runs against prod, which has no dev marker.
        const result = await run('psql', [targetUrl(), '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', 'scripts/export-dev-energy-data.sql']);
        const [header, ...lines] = result.stdout.trim().split('\n');
        expect(header).toBe('id,timestamp,site_id,load_power');
        const sites = lines.map((line) => line.split(',')[2]).sort();
        expect(sites).toEqual([PINNED_SITE, 'live3', 'live4', 'live5', 'live6', 'live7']);
        expect(lines.every((line) => line.endsWith(',10'))).toBe(true);
    });

    it('loads the EnergyData subset and drops archive days it no longer covers', async () => {
        await target!.query(`${MARK_DEV}
            DELETE FROM public."EnergyData";
            UPDATE public."Site" SET last_live_refresh_at = 500;
            INSERT INTO public."Site" (id, last_live_refresh_at) VALUES ('s2', 600);
            INSERT INTO public."EnergyDayArchive" VALUES
                ('s1', '2026-10-01T00:00Z', '2026-10-02T00:00Z', 2, false),
                ('s1', '2026-10-02T00:00Z', '2026-10-03T00:00Z', 5, false),
                ('s1', '2026-09-01T00:00Z', '2026-09-02T00:00Z', 288, true),
                ('s2', '2026-10-01T00:00Z', '2026-10-02T00:00Z', 3, false);`);
        const csv = 'id,timestamp,site_id,load_power\n'
            + '7,2026-10-01 01:00:00+00,s1,1.5\n'
            + '8,2026-10-01 02:00:00+00,s1,2.5\n'
            + '9,2026-10-02 01:00:00+00,s1,3.5\n';
        const result = await psqlWithInput(csv, '--single-transaction', '-v', 'ON_ERROR_STOP=1', '-f', 'scripts/load-dev-energy-data.sql');
        expect(result.code, result.out).toBe(0);
        expect(await rows(`SELECT id, load_power FROM public."EnergyData" ORDER BY id`))
            .toEqual([{ id: 7, load_power: 1.5 }, { id: 8, load_power: 2.5 }, { id: 9, load_power: 3.5 }]);
        // Kept: a day whose raw rows all arrived, and an archive-only (raw_pruned) day.
        // Dropped: days whose raw rows were not copied, as deleting them would have.
        expect(await rows(`SELECT site_id, to_char(day_start AT TIME ZONE 'UTC', 'MM-DD') AS day FROM public."EnergyDayArchive" ORDER BY 1, 2`))
            .toEqual([{ site_id: 's1', day: '09-01' }, { site_id: 's1', day: '10-01' }]);
        // Sites left without readings look idle, so beta's crons skip them.
        expect(await rows(`SELECT id, last_live_refresh_at::int AS t FROM public."Site" ORDER BY id`))
            .toEqual([{ id: 's1', t: 500 }, { id: 's2', t: 0 }]);
    });

    it('loads the subset without firing EnergyData triggers', async () => {
        await target!.query(`${MARK_DEV}
            DELETE FROM public."EnergyData";
            CREATE FUNCTION public.refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'trigger fired'; END $$;
            CREATE TRIGGER refuse BEFORE INSERT ON public."EnergyData" FOR EACH ROW EXECUTE FUNCTION public.refuse();`);
        const result = await psqlWithInput('id,timestamp,site_id,load_power\n1,2026-10-01 01:00:00+00,s1,1\n',
            '-v', 'ON_ERROR_STOP=1', '-f', 'scripts/load-dev-energy-data.sql');
        expect(result.code, result.out).toBe(0);
        expect(await rows(`SELECT count(*)::int AS n FROM public."EnergyData"`)).toEqual([{ n: 1 }]);
    });

    it('refuses an export whose columns do not match the dev table', async () => {
        await target!.query(`${MARK_DEV} DELETE FROM public."EnergyData";`);
        const result = await psqlWithInput('id,site_id,timestamp,load_power\n1,s1,2026-10-01 01:00:00+00,1\n',
            '-v', 'ON_ERROR_STOP=1', '-f', 'scripts/load-dev-energy-data.sql');
        expect(result.code).not.toBe(0);
        expect(await rows(`SELECT count(*)::int AS n FROM public."EnergyData"`)).toEqual([{ n: 0 }]);
    });

    it('prunes EnergyData older than 45 days on a marked dev copy', async () => {
        await target!.query(MARK_DEV);
        const result = await psql('scripts/prune-dev-copy.sql');
        expect(result.code, result.out).toBe(0);
        expect(await rows(`SELECT load_power FROM public."EnergyData" ORDER BY "timestamp"`))
            .toEqual([{ load_power: 3 }, { load_power: 4 }]);
        // The marker survives; the scripts never touch it.
        expect(await rows(`SELECT name FROM pwusage_env.environment`)).toEqual([{ name: 'dev' }]);
    });
});
