import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyBackupDirectory } from './verify-db-backup';

const copyBlock = (table: string, columns: string, rows: string[]) =>
    [`COPY "public"."${table}" (${columns}) FROM stdin;`, ...rows, '\\.', ''].join('\n');

const USERS = copyBlock('User', '"id", "email"', ['u1\ta@example.com']);
const SITES = copyBlock('Site', '"id", "user_id"', ['s1\tu1', 's2\tu1']);
const ENERGY = copyBlock('EnergyData', '"timestamp", "site_id", "load_power"', ['2026-10-15 00:00:00+00\ts1\t500']);
const ARCHIVES = copyBlock('EnergyDayArchive', '"site_id", "day_start"', ['s1\t2026-10-14 05:00:00+00']);
const SUMMARIES = copyBlock('EnergyDaySummary', '"site_id", "day_start", "tariff_id"', ['s1\t2026-10-14 05:00:00+00\t1']);
const PREAMBLE = 'SET session_replication_role = replica;\n';
const DAILY_INFO = 'kind=daily\ntaken_at=2026-10-15T09:23:05Z\n';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'pwusage-verify-backup-')); });
afterEach(async () => { await rm(dir, { recursive: true }); });

async function backup(files: Record<string, string>) {
    const base = { 'roles.sql': 'CREATE ROLE x;\n', 'schema.sql': 'CREATE TABLE t();\n' };
    for (const [name, body] of Object.entries({ ...base, ...files })) await writeFile(join(dir, name), body);
}

describe('verifyBackupDirectory', () => {
    it('accepts a complete backup and reports rows per table', async () => {
        await backup({ 'data.sql': PREAMBLE + USERS + SITES + ARCHIVES + SUMMARIES, 'backup-info': DAILY_INFO });
        await expect(verifyBackupDirectory(dir)).resolves.toEqual({ User: 1, Site: 2, EnergyDayArchive: 1, EnergyDaySummary: 1 });
    });

    it('accepts a backup taken before the single compact store, with raw history', async () => {
        await backup({ 'data.sql': PREAMBLE + USERS + SITES + ENERGY });
        await expect(verifyBackupDirectory(dir)).resolves.toEqual({ User: 1, Site: 2, EnergyData: 1 });
    });

    it('rejects a missing or empty file', async () => {
        await backup({ 'data.sql': PREAMBLE + USERS + SITES + ARCHIVES + SUMMARIES, 'schema.sql': '' });
        await expect(verifyBackupDirectory(dir)).rejects.toThrow('schema.sql is missing or empty');
    });

    it('rejects a dump cut off inside a table', async () => {
        await backup({ 'data.sql': PREAMBLE + USERS + SITES + ARCHIVES.replace('\\.\n', '') });
        await expect(verifyBackupDirectory(dir)).rejects.toThrow('truncated');
    });

    it('rejects a backup that is missing rows for a required table or energy history', async () => {
        await backup({ 'data.sql': PREAMBLE + USERS + copyBlock('Site', '"id"', []) + ARCHIVES + SUMMARIES });
        await expect(verifyBackupDirectory(dir)).rejects.toThrow('Site');
        await backup({ 'data.sql': PREAMBLE + USERS + SITES });
        await expect(verifyBackupDirectory(dir)).rejects.toThrow('no energy history');
    });

    it('rejects day records without their summary rows', async () => {
        await backup({ 'data.sql': PREAMBLE + USERS + SITES + ARCHIVES });
        await expect(verifyBackupDirectory(dir)).rejects.toThrow('EnergyDaySummary');
    });

    it('does not count empty day records, which have no summaries, as history', async () => {
        const empty = copyBlock('EnergyDayArchive', '"site_id", "day_start", "status"', ['s1\t2026-10-14 05:00:00+00\tempty']);
        await backup({ 'data.sql': PREAMBLE + USERS + SITES + empty });
        await expect(verifyBackupDirectory(dir)).rejects.toThrow('no energy history');
        await backup({ 'data.sql': PREAMBLE + USERS + SITES + empty + ENERGY });
        await expect(verifyBackupDirectory(dir)).resolves.toEqual({ User: 1, Site: 2, EnergyDayArchive: 1, EnergyData: 1 });
    });

    it('requires a valid timestamp when backup-info is present', async () => {
        await backup({ 'data.sql': PREAMBLE + USERS + SITES + ARCHIVES + SUMMARIES, 'backup-info': 'kind=daily\ntaken_at=yesterday\n' });
        await expect(verifyBackupDirectory(dir)).rejects.toThrow('taken_at');
    });

    it('accepts unquoted schema names the way pg_dump may write them', async () => {
        const unquoted = (PREAMBLE + USERS + SITES + ARCHIVES + SUMMARIES).replaceAll('"public".', 'public.');
        await backup({ 'data.sql': unquoted });
        await expect(verifyBackupDirectory(dir)).resolves.toEqual({ User: 1, Site: 2, EnergyDayArchive: 1, EnergyDaySummary: 1 });
    });
});
