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

// Mirrors the parts of the real schema the restore depends on: day records and
// their summaries, keyed by Site.
const SCHEMA = `
CREATE TABLE public."User" (id text PRIMARY KEY, email text);
CREATE TABLE public."Site" (id text PRIMARY KEY, user_id text REFERENCES public."User"(id));
CREATE TABLE public."EnergyDayArchive" (site_id text NOT NULL REFERENCES public."Site"(id) ON DELETE CASCADE,
    day_start timestamptz NOT NULL, day_end timestamptz NOT NULL, status text, PRIMARY KEY (site_id, day_start));
CREATE TABLE public."EnergyDaySummary" (site_id text NOT NULL, day_start timestamptz NOT NULL, load_power double precision);
`;

const copy = (table: string, columns: string, rows: string[]) =>
    [`COPY public."${table}" (${columns}) FROM stdin;`, ...rows, '\\.', ''].join('\n');
const T1 = '2026-10-01 00:00:00+00';
const T1_END = '2026-10-02 00:00:00+00';
const T2 = '2026-10-14 00:00:00+00';
const T2_END = '2026-10-15 00:00:00+00';

const DAILY = {
    'backup-info': 'kind=daily\ntaken_at=2026-10-15T09:23:00Z\n',
    'roles.sql': '-- no custom roles\n',
    'schema.sql': SCHEMA,
    'data.sql': 'SET session_replication_role = replica;\n'
        + copy('User', 'id, email', ['u1\told@example.com', 'u2\t\\N'])
        + copy('Site', 'id, user_id', ['s1\tu1', 's2\tu2'])
        + copy('EnergyDayArchive', 'site_id, day_start, day_end, status', [`s1\t${T1}\t${T1_END}\tcomplete`, `s2\t${T2}\t${T2_END}\tcomplete`])
        + copy('EnergyDaySummary', 'site_id, day_start, load_power', [`s1\t${T1}\t100`, `s2\t${T2}\t200`]),
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
        const result = await restore('--backup', await backupDir('daily', DAILY));
        expect(result.code).not.toBe(0);
        expect(result.out).toContain('already has tables');
        expect(await rows('SELECT id FROM public.keep_me')).toEqual([{ id: 1 }]);
        expect(await tableCount()).toBe(1);
    });

    it('restores any backup kind exactly as dumped, from a directory or a zip', async () => {
        const dir = await backupDir('daily', DAILY);
        const zip = join(work, 'daily.zip');
        await run('zip', ['-q', '-j', zip, ...Object.keys(DAILY).map((file) => join(dir, file))]);
        const result = await restore('--backup', zip);
        expect(result.out).toContain('Restore complete');
        expect(result.code).toBe(0);
        expect(await rows(`SELECT id, email FROM public."User" ORDER BY id`))
            .toEqual([{ id: 'u1', email: 'old@example.com' }, { id: 'u2', email: null }]);
        expect(await rows(`SELECT count(*)::int AS n FROM public."EnergyDayArchive"`)).toEqual([{ n: 2 }]);
        expect(await rows(`SELECT site_id, load_power FROM public."EnergyDaySummary" ORDER BY site_id`))
            .toEqual([{ site_id: 's1', load_power: 100 }, { site_id: 's2', load_power: 200 }]);
    });

    it('restores a legacy backup without backup-info', async () => {
        const { 'backup-info': _info, ...legacy } = DAILY;
        const result = await restore('--backup', await backupDir('weekly', legacy));
        expect(result.out).toContain('Restore complete');
        expect(await rows(`SELECT id FROM public."Site" ORDER BY id`)).toEqual([{ id: 's1' }, { id: 's2' }]);
    });

    it('rolls back completely when the backup does not load', async () => {
        const broken = { ...DAILY, 'data.sql': DAILY['data.sql'].replace('site_id, day_start, load_power', 'site_id, day_start, removed_column') };
        const result = await restore('--backup', await backupDir('daily', broken));
        expect(result.code).not.toBe(0);
        expect(result.out).toContain('removed_column');
        expect(await tableCount()).toBe(0);
    });

    it('rejects missing arguments and unreadable backups before touching the target', async () => {
        expect((await restore()).out).toContain('Usage');
        const missing = await restore('--backup', join(work, 'nope'));
        expect(missing.code).not.toBe(0);
        expect(missing.out).toContain('not found');
        const incomplete = await restore('--backup', await backupDir('broken', { 'roles.sql': '-- none\n', 'schema.sql': SCHEMA }));
        expect(incomplete.code).not.toBe(0);
        expect(incomplete.out).toContain('data.sql');
        expect(await tableCount()).toBe(0);
    });
});
