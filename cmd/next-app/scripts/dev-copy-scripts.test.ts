import { execFile } from 'node:child_process';
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
CREATE TABLE public."Site" (id text PRIMARY KEY);
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
`;

const MARK_DEV = `CREATE SCHEMA pwusage_env; CREATE TABLE pwusage_env.environment (name text PRIMARY KEY); INSERT INTO pwusage_env.environment VALUES ('dev');`;
const DEV_SCRIPTS = ['scripts/assert-dev-database.sql', 'scripts/sanitize-dev-copy.sql', 'scripts/prune-dev-copy.sql'];

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

    const snapshot = async () => ({
        energy: await rows(`SELECT count(*)::int AS n FROM public."EnergyData"`),
        handoffs: await rows(`SELECT count(*)::int AS n FROM public."MobileLoginHandoff"`),
        trmnl: await rows(`SELECT access_token, refresh_token FROM public."TrmnlInstallation"`),
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
        await target!.query(`${MARK_DEV} DROP TABLE public."MobileLoginHandoff"; DROP TABLE public."TrmnlInstallation"; DROP TABLE public."EnergyData";`);
        expect((await psql('scripts/sanitize-dev-copy.sql')).code).toBe(0);
        expect((await psql('scripts/prune-dev-copy.sql')).code).toBe(0);
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
