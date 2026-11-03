import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const socket = process.env.DEV_HISTORY_TEST_SOCKET;
const safeSocket = socket && /^\/(?:private\/)?tmp\/dev-history-pg-[a-zA-Z0-9]+$/.test(socket);
if (socket && !safeSocket) throw new Error('Dev history script tests require a disposable private local socket');
const PORT = 55443;

// The parts of the real schema the reset and restore touch, with the same keys and cascades.
const SCHEMA = `
CREATE TABLE public."Site" (
    id text PRIMARY KEY, name text NOT NULL, timezone text NOT NULL DEFAULT 'America/Chicago',
    import_lock_id text, import_lock_expires bigint, last_import_at bigint,
    history_backfill_from timestamptz, history_migrated_at timestamptz);
CREATE TABLE public."Tariff" (id serial PRIMARY KEY);
CREATE TABLE public."TariffSchedule" (id serial PRIMARY KEY);
CREATE TABLE public."EnergyDayArchive" (
    site_id text NOT NULL REFERENCES public."Site"(id) ON DELETE CASCADE,
    day_start timestamptz NOT NULL,
    revision uuid NOT NULL,
    payload bytea,
    attribution jsonb,
    status text,
    PRIMARY KEY (site_id, day_start),
    UNIQUE (site_id, day_start, revision));
CREATE TABLE public."EnergyDaySummary" (
    site_id text NOT NULL,
    day_start timestamptz NOT NULL,
    revision uuid NOT NULL,
    tariff_id integer NOT NULL REFERENCES public."Tariff"(id),
    tariff_schedule_id integer REFERENCES public."TariffSchedule"(id),
    sample_count integer NOT NULL,
    FOREIGN KEY (site_id, day_start, revision) REFERENCES public."EnergyDayArchive"(site_id, day_start, revision) ON DELETE CASCADE);
INSERT INTO public."Tariff" VALUES (1), (2);
INSERT INTO public."TariffSchedule" VALUES (1);
INSERT INTO public."Site" (id, name, history_backfill_from) VALUES
    ('s1', 'Harrison', '2023-11-28T06:00:00Z'), ('s2', 'Elsewhere', NULL);
INSERT INTO public."EnergyDayArchive"
SELECT site, timestamptz '2026-10-01T05:00:00Z' + day * interval '1 day', gen_random_uuid(),
       decode(md5(site || day), 'hex'), jsonb_build_object('segments', jsonb_build_array(day), 'note', 'a "quoted", line\\n'),
       'complete'
FROM (VALUES ('s1'), ('s2')) sites(site), generate_series(0, 4) day;
INSERT INTO public."EnergyDaySummary"
SELECT site_id, day_start, revision, 1, 1, 288 FROM public."EnergyDayArchive"
UNION ALL
SELECT site_id, day_start, revision, 2, NULL, 12 FROM public."EnergyDayArchive" WHERE site_id = 's1';
`;
const MARK_DEV = `CREATE SCHEMA pwusage_env; CREATE TABLE pwusage_env.environment (name text PRIMARY KEY); INSERT INTO pwusage_env.environment VALUES ('dev');`;

describe.skipIf(!safeSocket)('dev history reset and restore against isolated PostgreSQL', { timeout: 30000 }, () => {
    let admin: Pool;
    let target: Pool | undefined;
    let caseNumber = 0;
    let database = '';
    let work = '';

    beforeAll(() => { admin = new Pool({ host: socket, port: PORT, user: process.env.USER, database: 'postgres', max: 2 }); });
    afterAll(async () => { await admin?.end(); });
    beforeEach(async () => {
        caseNumber += 1;
        database = `dev_history_case_${caseNumber}`;
        await admin.query(`CREATE DATABASE ${database}`);
        target = new Pool({ host: socket, port: PORT, user: process.env.USER, database, max: 2 });
        await target.query(SCHEMA);
        work = await mkdtemp(join(tmpdir(), 'pwusage-dev-history-'));
    });
    afterEach(async () => { await target?.end(); await rm(work, { recursive: true }); });

    const url = () => `postgresql:///${database}?host=${encodeURIComponent(socket!)}&port=${PORT}`;
    const rows = async (sql: string) => (await target!.query(sql)).rows;
    const snapshotDir = () => join(work, 'snapshot');
    // Every row of both tables, as text, so any change anywhere shows.
    const state = async () => ({
        archive: await rows(`SELECT a::text AS row FROM public."EnergyDayArchive" a ORDER BY a::text`),
        summary: await rows(`SELECT s::text AS row FROM public."EnergyDaySummary" s ORDER BY s::text`),
        sites: await rows(`SELECT s::text AS row FROM public."Site" s ORDER BY id`),
    });
    const siteRows = async (site: string) =>
        (await rows(`SELECT count(*)::int AS n FROM public."EnergyDayArchive" WHERE site_id = '${site}'`))[0].n;

    function sh(script: string, ...args: string[]) {
        return new Promise<{ code: number; out: string }>((done) => {
            const child = spawn('bash', [resolve('scripts', script), ...args]);
            let out = '';
            child.stdout.on('data', (chunk) => { out += chunk; });
            child.stderr.on('data', (chunk) => { out += chunk; });
            child.on('close', (code) => done({ code: code ?? 1, out }));
        });
    }
    const reset = (site = 's1', name = 'Harrison', dir = snapshotDir()) =>
        sh('dev-history-reset.sh', '--database-url', url(), '--site', site, '--expect-name', name, '--snapshot', dir);
    const restore = (...extra: string[]) =>
        sh('dev-history-restore.sh', '--database-url', url(), '--site', 's1', '--snapshot', snapshotDir(), ...extra);

    describe('reset', () => {
        it('refuses a database without the dev marker, changes nothing and leaves no snapshot', async () => {
            const before = await state();
            const result = await reset();
            expect(result.code).not.toBe(0);
            expect(result.out).toContain('not marked as a dev database');
            expect(await state()).toEqual(before);
            await expect(stat(snapshotDir())).rejects.toThrow();
        });

        it.each([
            ['an unknown site', 'nope', 'Harrison', 'there is no site nope'],
            ['a site whose name does not match', 's1', 'Cedar House', 'is named "Harrison", not "Cedar House"'],
        ])('refuses %s', async (_label, site, name, message) => {
            await target!.query(MARK_DEV);
            const before = await state();
            const result = await reset(site, name);
            expect(result.code).not.toBe(0);
            expect(result.out).toContain(message);
            expect(await state()).toEqual(before);
        });

        it('refuses while an import holds the site lock', async () => {
            await target!.query(MARK_DEV);
            await target!.query(`UPDATE public."Site" SET import_lock_id = 'x', import_lock_expires = $1 WHERE id = 's1'`, [Date.now() + 60_000]);
            const before = await state();
            const result = await reset();
            expect(result.out).toContain('an import holds this site');
            expect(await state()).toEqual(before);
        });

        it('never overwrites an existing snapshot', async () => {
            await target!.query(MARK_DEV);
            await writeFile(join(work, 'taken'), 'x');
            const result = await reset('s1', 'Harrison', join(work, 'taken'));
            expect(result.code).not.toBe(0);
            expect(result.out).toContain('already exists');
            expect(await siteRows('s1')).toBe(5);
        });

        it('saves a private, verified snapshot and deletes only that site\'s history', async () => {
            await target!.query(MARK_DEV);
            const others = await rows(`SELECT a::text FROM public."EnergyDayArchive" a WHERE site_id = 's2' ORDER BY 1`);
            const result = await reset();
            expect(result.code, result.out).toBe(0);
            expect(await siteRows('s1')).toBe(0);
            expect((await rows(`SELECT count(*)::int AS n FROM public."EnergyDaySummary" WHERE site_id = 's1'`))[0].n).toBe(0);
            expect(await rows(`SELECT a::text FROM public."EnergyDayArchive" a WHERE site_id = 's2' ORDER BY 1`)).toEqual(others);
            expect((await rows(`SELECT name, history_backfill_from FROM public."Site" WHERE id = 's1'`))[0].name).toBe('Harrison');

            const manifest = JSON.parse(await readFile(join(snapshotDir(), 'manifest.json'), 'utf8'));
            expect(manifest.kind).toBe('pwusage-dev-history-snapshot');
            expect(manifest.site).toMatchObject({ id: 's1', name: 'Harrison' });
            expect(manifest.archive.rows).toBe(5);
            expect(manifest.summary.rows).toBe(10);
            expect(manifest.archive.digest).toMatch(/^[0-9a-f]{32}$/);
            expect(manifest.database.project_ref).toBeNull();
            expect((await stat(snapshotDir())).mode & 0o777).toBe(0o700);
            expect((await stat(join(snapshotDir(), 'archive.csv'))).mode & 0o777).toBe(0o600);
        });
    });

    describe('restore', () => {
        let original: Awaited<ReturnType<typeof state>>;
        beforeEach(async () => {
            await target!.query(MARK_DEV);
            original = await state();
            const result = await reset();
            expect(result.code, result.out).toBe(0);
        });
        // A test import: one day the snapshot also has (newer revision) and one new day.
        const importDuringTest = async () => {
            await target!.query(`
                INSERT INTO public."EnergyDayArchive" VALUES
                    ('s1', '2026-10-01T05:00:00Z', gen_random_uuid(), '\\x01', '{"segments": []}', 'complete'),
                    ('s1', '2026-10-20T05:00:00Z', gen_random_uuid(), '\\x02', '{"segments": []}', 'open');
                UPDATE public."Site" SET history_backfill_from = '2024-01-01T06:00:00Z' WHERE id = 's1';`);
        };

        it('puts an emptied site back exactly', async () => {
            const result = await restore();
            expect(result.code, result.out).toBe(0);
            expect(await state()).toEqual(original);
        });

        it('refuses to touch history imported since the reset unless told how', async () => {
            await importDuringTest();
            const before = await state();
            const result = await restore();
            expect(result.code).not.toBe(0);
            expect(result.out).toContain('Choose --replace');
            expect(await state()).toEqual(before);
        });

        it('previews conflicts without changing anything', async () => {
            await importDuringTest();
            const before = await state();
            const result = await restore('--preview');
            expect(result.code, result.out).toBe(0);
            expect(result.out).toMatch(/snapshot_days.*\n.*\n\s*5\s*\|\s*2\s*\|\s*1\s*\|\s*0\s*\|\s*1\s*\|\s*4/);
            expect(result.out).toContain('Preview only');
            expect(await state()).toEqual(before);
        });

        it('replace discards the test import and returns exactly to the snapshot', async () => {
            await importDuringTest();
            const result = await restore('--replace');
            expect(result.code, result.out).toBe(0);
            expect(await state()).toEqual(original);
        });

        it('keep-newer keeps every test record and restores only the missing days', async () => {
            await importDuringTest();
            const kept = await rows(`SELECT a::text FROM public."EnergyDayArchive" a WHERE site_id = 's1' ORDER BY 1`);
            const result = await restore('--keep-newer');
            expect(result.code, result.out).toBe(0);
            const now = await rows(`SELECT a::text FROM public."EnergyDayArchive" a WHERE site_id = 's1' ORDER BY 1`);
            expect(now).toEqual(expect.arrayContaining(kept));
            expect(now).toHaveLength(6);
            // The kept day has no summaries of its own; the four restored days have theirs.
            expect((await rows(`SELECT count(*)::int AS n FROM public."EnergyDaySummary" WHERE site_id = 's1'`))[0].n).toBe(8);
            expect((await rows(`SELECT history_backfill_from FROM public."Site" WHERE id = 's1'`))[0].history_backfill_from)
                .toEqual(new Date('2024-01-01T06:00:00Z'));
        });

        it.each([
            ['another site', async () => {}, ['--site', 's2'], 'the snapshot is for site s1, not s2'],
            ['a changed archive file', async (dir: string) => {
                const file = join(dir, 'archive.csv');
                await writeFile(file, (await readFile(file, 'utf8')).replace('complete', 'gapped'));
            }, [], 'do not match manifest.json'],
            ['a missing file', async (dir: string) => { await rm(join(dir, 'summary.csv')); }, [], 'summary.csv is missing'],
            ['a snapshot from another project', async (dir: string) => {
                const file = join(dir, 'manifest.json');
                const manifest = JSON.parse(await readFile(file, 'utf8'));
                manifest.database.project_ref = 'otherproject';
                await writeFile(file, JSON.stringify(manifest));
            }, [], 'taken from another database'],
            ['a changed schema', async () => {
                await target!.query(`ALTER TABLE public."EnergyDayArchive" ADD COLUMN extra text`);
            }, [], 'columns changed since the snapshot'],
        ])('refuses %s and changes nothing', async (_label, spoil, args, message) => {
            await spoil(snapshotDir());
            const before = await state();
            const result = await sh('dev-history-restore.sh', '--database-url', url(), '--site', 's1', '--snapshot', snapshotDir(), ...args);
            expect(result.code).not.toBe(0);
            expect(result.out).toContain(message);
            expect(await state()).toEqual(before);
        });

        it('refuses a database without the dev marker', async () => {
            await target!.query(`DROP SCHEMA pwusage_env CASCADE`);
            const before = await state();
            const result = await restore();
            expect(result.out).toContain('not marked as a dev database');
            expect(await state()).toEqual(before);
        });

        it('a restore that fails part way leaves the database as it was', async () => {
            // The day records insert, then a summary names a rate plan that no longer exists.
            await target!.query(`DELETE FROM public."Tariff" WHERE id = 2`);
            const before = await state();
            const result = await restore();
            expect(result.code).not.toBe(0);
            expect(result.out).toContain('Restore refused or failed');
            expect(await state()).toEqual(before);
        });
    });
});
