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
const RECENT = 'timestamp,site_id,load_power\n2026-10-15 00:00:00+00,s1,500\n';
const DAILY_INFO = 'kind=daily\ndump=small\ntaken_at=2026-10-15T09:23:05Z\n';
const WEEKLY_INFO = 'kind=weekly\ndump=full\ntaken_at=2026-10-12T09:41:00Z\n';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'pwusage-verify-backup-')); });
afterEach(async () => { await rm(dir, { recursive: true }); });

async function backup(files: Record<string, string>) {
    const base = { 'roles.sql': 'CREATE ROLE x;\n', 'schema.sql': 'CREATE TABLE t();\n' };
    for (const [name, body] of Object.entries({ ...base, ...files })) await writeFile(join(dir, name), body);
}

describe('verifyBackupDirectory', () => {
    it('accepts a complete full backup and reports rows per table', async () => {
        await backup({ 'data.sql': PREAMBLE + USERS + SITES + ENERGY });
        await expect(verifyBackupDirectory(dir, 'full')).resolves.toEqual({ User: 1, Site: 2, EnergyData: 1 });
    });

    it('accepts a small backup with recent energy readings kept separately', async () => {
        await backup({ 'data.sql': PREAMBLE + USERS + SITES, 'energy-recent.csv': RECENT, 'backup-info': DAILY_INFO });
        await expect(verifyBackupDirectory(dir, 'small')).resolves.toEqual({ User: 1, Site: 2, 'EnergyData (recent)': 1 });
    });

    it('rejects a missing or empty file', async () => {
        await backup({ 'data.sql': PREAMBLE + USERS + SITES + ENERGY, 'schema.sql': '' });
        await expect(verifyBackupDirectory(dir, 'full')).rejects.toThrow('schema.sql is missing or empty');
    });

    it('rejects a dump cut off inside a table', async () => {
        await backup({ 'data.sql': PREAMBLE + USERS + SITES + ENERGY.replace('\\.\n', '') });
        await expect(verifyBackupDirectory(dir, 'full')).rejects.toThrow('truncated');
    });

    it('rejects a full backup that is missing rows for a required table', async () => {
        await backup({ 'data.sql': PREAMBLE + USERS + copyBlock('Site', '"id"', []) + ENERGY });
        await expect(verifyBackupDirectory(dir, 'full')).rejects.toThrow('Site');
        await backup({ 'data.sql': PREAMBLE + USERS + SITES });
        await expect(verifyBackupDirectory(dir, 'full')).rejects.toThrow('no energy history (EnergyData or EnergyDayArchive)');
    });

    it('accepts a full backup whose history is all in day records, after raw storage is drained', async () => {
        const drained = copyBlock('EnergyData', '"timestamp", "site_id", "load_power"', []);
        await backup({ 'data.sql': PREAMBLE + USERS + SITES + drained + ARCHIVES + SUMMARIES });
        await expect(verifyBackupDirectory(dir, 'full')).resolves.toEqual({ User: 1, Site: 2, EnergyData: 0, EnergyDayArchive: 1, EnergyDaySummary: 1 });
    });

    it('rejects day records without their summary rows', async () => {
        await backup({ 'data.sql': PREAMBLE + USERS + SITES + ENERGY + ARCHIVES });
        await expect(verifyBackupDirectory(dir, 'full')).rejects.toThrow('EnergyDaySummary');
        await backup({ 'data.sql': PREAMBLE + USERS + SITES + ARCHIVES, 'energy-recent.csv': RECENT, 'backup-info': DAILY_INFO });
        await expect(verifyBackupDirectory(dir, 'small')).rejects.toThrow('EnergyDaySummary');
    });

    it('accepts empty day records, which have no summaries, alongside raw history', async () => {
        const empty = copyBlock('EnergyDayArchive', '"site_id", "day_start", "status"', ['s1\t2026-10-13 05:00:00+00\tempty']);
        await backup({ 'data.sql': PREAMBLE + USERS + SITES + ENERGY + empty });
        await expect(verifyBackupDirectory(dir, 'full')).resolves.toEqual({ User: 1, Site: 2, EnergyData: 1, EnergyDayArchive: 1 });
        // Empty records alone are not energy history.
        await backup({ 'data.sql': PREAMBLE + USERS + SITES + empty });
        await expect(verifyBackupDirectory(dir, 'full')).rejects.toThrow('no energy history');
        // A record with samples still needs its summaries.
        const mixed = copyBlock('EnergyDayArchive', '"site_id", "day_start", "status"', ['s1\t2026-10-13 05:00:00+00\tempty', 's1\t2026-10-14 05:00:00+00\tcomplete']);
        await backup({ 'data.sql': PREAMBLE + USERS + SITES + ENERGY + mixed });
        await expect(verifyBackupDirectory(dir, 'full')).rejects.toThrow('EnergyDaySummary');
    });

    it('rejects a small backup whose data still contains EnergyData, so a failed exclusion is caught', async () => {
        await backup({ 'data.sql': PREAMBLE + USERS + SITES + ENERGY, 'energy-recent.csv': RECENT, 'backup-info': DAILY_INFO });
        await expect(verifyBackupDirectory(dir, 'small')).rejects.toThrow('EnergyData was not excluded');
    });

    it('rejects a small backup without a recent-readings file header', async () => {
        await backup({ 'data.sql': PREAMBLE + USERS + SITES, 'energy-recent.csv': '', 'backup-info': DAILY_INFO });
        await expect(verifyBackupDirectory(dir, 'small')).rejects.toThrow('energy-recent.csv');
        await backup({ 'data.sql': PREAMBLE + USERS + SITES, 'energy-recent.csv': 'a,b\n1,2\n', 'backup-info': DAILY_INFO });
        await expect(verifyBackupDirectory(dir, 'small')).rejects.toThrow('header');
    });

    it('accepts a full backup with matching backup-info, and a legacy one without it', async () => {
        await backup({ 'data.sql': PREAMBLE + USERS + SITES + ENERGY, 'backup-info': WEEKLY_INFO });
        await expect(verifyBackupDirectory(dir, 'full')).resolves.toEqual({ User: 1, Site: 2, EnergyData: 1 });
    });

    it('rejects a daily backup offered as a full one', async () => {
        await backup({ 'data.sql': PREAMBLE + USERS + SITES, 'energy-recent.csv': RECENT, 'backup-info': DAILY_INFO });
        await expect(verifyBackupDirectory(dir, 'full')).rejects.toThrow('a small backup, not full');
    });

    it('requires backup-info with a valid timestamp on daily backups', async () => {
        await backup({ 'data.sql': PREAMBLE + USERS + SITES, 'energy-recent.csv': RECENT });
        await expect(verifyBackupDirectory(dir, 'small')).rejects.toThrow('backup-info is missing');
        await backup({ 'data.sql': PREAMBLE + USERS + SITES, 'energy-recent.csv': RECENT, 'backup-info': 'kind=daily\ndump=small\ntaken_at=yesterday\n' });
        await expect(verifyBackupDirectory(dir, 'small')).rejects.toThrow('taken_at');
    });

    it('accepts unquoted schema names the way pg_dump may write them', async () => {
        const unquoted = (PREAMBLE + USERS + SITES + ENERGY).replaceAll('"public".', 'public.');
        await backup({ 'data.sql': unquoted });
        await expect(verifyBackupDirectory(dir, 'full')).resolves.toEqual({ User: 1, Site: 2, EnergyData: 1 });
    });
});
