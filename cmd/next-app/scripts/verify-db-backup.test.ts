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
const PREAMBLE = 'SET session_replication_role = replica;\n';
const RECENT = 'timestamp,site_id,load_power\n2026-10-15 00:00:00+00,s1,500\n';

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
        await backup({ 'data.sql': PREAMBLE + USERS + SITES, 'energy-recent.csv': RECENT });
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
        await expect(verifyBackupDirectory(dir, 'full')).rejects.toThrow('EnergyData');
    });

    it('rejects a small backup whose data still contains EnergyData, so a failed exclusion is caught', async () => {
        await backup({ 'data.sql': PREAMBLE + USERS + SITES + ENERGY, 'energy-recent.csv': RECENT });
        await expect(verifyBackupDirectory(dir, 'small')).rejects.toThrow('EnergyData was not excluded');
    });

    it('rejects a small backup without a recent-readings file header', async () => {
        await backup({ 'data.sql': PREAMBLE + USERS + SITES, 'energy-recent.csv': '' });
        await expect(verifyBackupDirectory(dir, 'small')).rejects.toThrow('energy-recent.csv');
        await backup({ 'data.sql': PREAMBLE + USERS + SITES, 'energy-recent.csv': 'a,b\n1,2\n' });
        await expect(verifyBackupDirectory(dir, 'small')).rejects.toThrow('header');
    });

    it('accepts unquoted schema names the way pg_dump may write them', async () => {
        const unquoted = (PREAMBLE + USERS + SITES + ENERGY).replaceAll('"public".', 'public.');
        await backup({ 'data.sql': unquoted });
        await expect(verifyBackupDirectory(dir, 'full')).resolves.toEqual({ User: 1, Site: 2, EnergyData: 1 });
    });
});
