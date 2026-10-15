import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const socket = process.env.DB_BACKUP_TEST_SOCKET;
const safeSocket = socket && /^\/(?:private\/)?tmp\/db-backup-pg-[a-zA-Z0-9]+$/.test(socket);
if (socket && !safeSocket) throw new Error('Backup restore tests require a disposable private local socket');

// Mirrors the parts of the real schema the restore depends on: the EnergyData
// unique key, its foreign key to Site, and a trigger that clears archived days.
const SCHEMA = `
CREATE TABLE public."User" (id text PRIMARY KEY, email text);
CREATE TABLE public."Site" (id text PRIMARY KEY, user_id text REFERENCES public."User"(id));
CREATE TABLE public."EnergyData" (
    id serial PRIMARY KEY,
    "timestamp" timestamptz NOT NULL,
    site_id text NOT NULL REFERENCES public."Site"(id) ON DELETE CASCADE,
    load_power double precision,
    battery_soc double precision DEFAULT 0 NOT NULL
);
CREATE UNIQUE INDEX energy_ts_site_uidx ON public."EnergyData"("timestamp", site_id);
CREATE TABLE public."EnergyDayArchive" (site_id text NOT NULL, day_start timestamptz NOT NULL);
CREATE FUNCTION public.invalidate_day() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN DELETE FROM public."EnergyDayArchive" WHERE site_id = NEW.site_id; RETURN NEW; END; $$;
CREATE TRIGGER invalidate_day BEFORE INSERT OR UPDATE ON public."EnergyData"
FOR EACH ROW EXECUTE FUNCTION public.invalidate_day();
`;

const copy = (table: string, columns: string, rows: string[]) =>
    [`COPY public."${table}" (${columns}) FROM stdin;`, ...rows, '\\.', ''].join('\n');
const T1 = '2026-10-01 00:00:00+00';
const T2 = '2026-10-14 00:00:00+00';
const T3 = '2026-10-15 00:00:00+00';

const WEEKLY = {
    'roles.sql': '-- no custom roles\n',
    'schema.sql': SCHEMA,
    'data.sql': 'SET session_replication_role = replica;\n'
        + copy('User', 'id, email', ['u1\told@example.com'])
        + copy('Site', 'id, user_id', ['s1\tu1', 's2\tu1'])
        + copy('EnergyData', 'id, "timestamp", site_id, load_power, battery_soc', [`1\t${T1}\ts1\t100\t50`, `2\t${T2}\ts1\t100\t50`, `3\t${T1}\ts2\t200\t50`])
        + copy('EnergyDayArchive', 'site_id, day_start', [`s1\t${T1}`])
        + `SELECT pg_catalog.setval('public."EnergyData_id_seq"', 3, true);\n`,
};

const DAILY = {
    'roles.sql': '-- no custom roles\n',
    'schema.sql': SCHEMA,
    'data.sql': 'SET session_replication_role = replica;\n'
        + copy('User', 'id, email', ['u1\tnew@example.com', 'u2\t\\N'])
        + copy('Site', 'id, user_id', ['s1\tu1', 's3\tu2'])
        + copy('EnergyDayArchive', 'site_id, day_start', [`s1\t${T1}`])
        // pg_dump keeps EnergyData's sequence even when the table's data is excluded,
        // but the recent readings are copied a moment later: id 5 landed in between.
        + `SELECT pg_catalog.setval('public."EnergyData_id_seq"', 4, true);\n`,
    'energy-recent.csv': `id,timestamp,site_id,load_power,battery_soc\n2,${T2},s1,150,60\n5,${T3},s3,300,70\n`,
};

describe.skipIf(!safeSocket)('restore-db-backup.sh against isolated PostgreSQL', () => {
    let admin: Pool;
    let work: string;
    let target: Pool | undefined;
    let caseNumber = 0;
    let database = '';

    beforeAll(() => { admin = new Pool({ host: socket, port: 55441, user: process.env.USER, database: 'postgres', max: 2 }); });
    afterAll(async () => { await admin?.end(); });
    beforeEach(async () => {
        caseNumber += 1;
        database = `restore_case_${caseNumber}`;
        await admin.query(`CREATE DATABASE ${database}`);
        target = new Pool({ host: socket, port: 55441, user: process.env.USER, database, max: 2 });
        work = await mkdtemp(join(tmpdir(), 'pwusage-restore-test-'));
    });
    afterEach(async () => {
        await target?.end();
        await rm(work, { recursive: true });
    });

    const targetUrl = () => `postgresql:///${database}?host=${encodeURIComponent(socket!)}&port=55441`;

    async function backupDir(name: string, files: Record<string, string>) {
        const dir = join(work, name);
        await mkdir(dir);
        for (const [file, body] of Object.entries(files)) await writeFile(join(dir, file), body);
        return dir;
    }

    async function restore(...args: string[]) {
        try {
            const result = await run('bash', ['scripts/restore-db-backup.sh', '--target', targetUrl(), ...args]);
            return { code: 0, out: result.stdout + result.stderr };
        } catch (error) {
            const failed = error as { code: number; stdout: string; stderr: string };
            return { code: failed.code, out: failed.stdout + failed.stderr };
        }
    }

    const rows = async (sql: string) => (await target!.query(sql)).rows;
    const tableCount = async () => Number((await rows(`SELECT count(*) AS n FROM pg_tables WHERE schemaname = 'public'`))[0].n);

    it('refuses a target that already has tables, and leaves it untouched', async () => {
        await target!.query('CREATE TABLE public.keep_me (id int); INSERT INTO public.keep_me VALUES (1)');
        const result = await restore('--full', await backupDir('weekly', WEEKLY));
        expect(result.code).not.toBe(0);
        expect(result.out).toContain('already has tables');
        expect(await rows('SELECT id FROM public.keep_me')).toEqual([{ id: 1 }]);
        expect(await tableCount()).toBe(1);
    });

    it('restores a full backup exactly as dumped', async () => {
        const result = await restore('--full', await backupDir('weekly', WEEKLY));
        expect(result.out).toContain('Restore complete');
        expect(result.code).toBe(0);
        expect(await rows(`SELECT id FROM public."Site" ORDER BY id`)).toEqual([{ id: 's1' }, { id: 's2' }]);
        expect(await rows(`SELECT count(*)::int AS n FROM public."EnergyData"`)).toEqual([{ n: 3 }]);
        expect(await rows(`SELECT count(*)::int AS n FROM public."EnergyDayArchive"`)).toEqual([{ n: 1 }]);
    });

    it('combines a weekly full with a newer zipped daily backup', async () => {
        const weekly = await backupDir('weekly', WEEKLY);
        const dailyDir = await backupDir('daily', DAILY);
        const dailyZip = join(work, 'daily.zip');
        await run('zip', ['-q', '-j', dailyZip, ...Object.keys(DAILY).map((file) => join(dailyDir, file))]);

        const result = await restore('--full', weekly, '--daily', dailyZip);
        expect(result.out).toContain('Restore complete');
        expect(result.code).toBe(0);

        // Small tables come from the newer daily backup.
        expect(await rows(`SELECT id, email FROM public."User" ORDER BY id`))
            .toEqual([{ id: 'u1', email: 'new@example.com' }, { id: 'u2', email: null }]);
        expect(await rows(`SELECT id FROM public."Site" ORDER BY id`)).toEqual([{ id: 's1' }, { id: 's3' }]);
        // History comes from the weekly; recent readings win; deleted sites' rows are dropped.
        expect(await rows(`SELECT to_char("timestamp" AT TIME ZONE 'UTC', 'MM-DD') AS day, site_id, load_power, battery_soc
                           FROM public."EnergyData" ORDER BY site_id, "timestamp"`)).toEqual([
            { day: '10-01', site_id: 's1', load_power: 100, battery_soc: 50 },
            { day: '10-14', site_id: 's1', load_power: 150, battery_soc: 60 },
            { day: '10-15', site_id: 's3', load_power: 300, battery_soc: 70 },
        ]);
        // Triggers stay paused, as when the dump itself loads.
        expect(await rows(`SELECT count(*)::int AS n FROM public."EnergyDayArchive"`)).toEqual([{ n: 1 }]);
    });

    it('advances the EnergyData id sequence past every restored row', async () => {
        const result = await restore('--full', await backupDir('weekly', WEEKLY), '--daily', await backupDir('daily', DAILY));
        expect(result.code).toBe(0);
        // The app inserts readings without an id; the next one must not reuse a restored id.
        const inserted = await rows(`INSERT INTO public."EnergyData" ("timestamp", site_id, load_power)
                                     VALUES ('2026-10-16 00:00:00+00', 's1', 1) RETURNING id`);
        expect(inserted[0].id).toBeGreaterThan(5);
    });

    it('rolls back completely when the backups do not fit together', async () => {
        const mismatched = { ...WEEKLY, 'data.sql': WEEKLY['data.sql'].replace('load_power, battery_soc', 'load_power, removed_column') };
        const result = await restore('--full', await backupDir('weekly', mismatched), '--daily', await backupDir('daily', DAILY));
        expect(result.code).not.toBe(0);
        expect(result.out).toContain('removed_column');
        expect(await tableCount()).toBe(0);
    });

    it('rejects missing arguments and unreadable backups before touching the target', async () => {
        expect((await restore()).out).toContain('Usage');
        const missing = await restore('--full', join(work, 'nope'));
        expect(missing.code).not.toBe(0);
        expect(missing.out).toContain('not found');
        const incomplete = await restore('--full', await backupDir('broken', { 'roles.sql': '-- none\n', 'schema.sql': SCHEMA }));
        expect(incomplete.code).not.toBe(0);
        expect(incomplete.out).toContain('data.sql');
        expect(await tableCount()).toBe(0);
    });
});
