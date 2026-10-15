import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BackupDump } from './db-backup-kinds';

// pg_dump writes `COPY public."User" (...) FROM stdin;`; tolerate quoted or bare names.
const COPY_HEADER = /^COPY\s+(?:"?public"?\.)?"?([^"\s(]+)"?\s*(?:\(.*\))?\s+FROM\s+stdin;$/;
const RECENT_ENERGY = 'energy-recent.csv';
const BACKUP_INFO = 'backup-info';
const TAKEN_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

async function required(dir: string, name: string): Promise<string> {
    let body = '';
    try { body = await readFile(join(dir, name), 'utf8'); } catch { /* reported below */ }
    if (body.length === 0) throw new Error(`${name} is missing or empty`);
    return body;
}

/** `key=value` lines written by dump-db-backup.sh; undefined for backups made before it existed. */
export async function readBackupInfo(dir: string): Promise<Record<string, string> | undefined> {
    let body: string;
    try { body = await readFile(join(dir, BACKUP_INFO), 'utf8'); } catch { return undefined; }
    return Object.fromEntries(body.split('\n').filter((line) => line.includes('=')).map((line) => {
        const at = line.indexOf('=');
        return [line.slice(0, at), line.slice(at + 1)];
    }));
}

/** Rows per table in a pg_dump data file; throws if a table's data is cut off. */
export function countCopyRows(data: string): Record<string, number> {
    const rows: Record<string, number> = {};
    let table: string | undefined;
    for (const line of data.split('\n')) {
        if (table === undefined) {
            const match = COPY_HEADER.exec(line);
            if (match) { table = match[1]; rows[table] = 0; }
        } else if (line === '\\.') {
            table = undefined;
        } else {
            rows[table] += 1;
        }
    }
    if (table !== undefined) throw new Error(`data.sql is truncated inside ${table}`);
    return rows;
}

/**
 * Checks an unpacked backup before it is uploaded, so an empty, truncated or
 * mis-scoped dump fails the run instead of being stored as a good backup.
 */
export async function verifyBackupDirectory(dir: string, dump: BackupDump): Promise<Record<string, number>> {
    await required(dir, 'roles.sql');
    await required(dir, 'schema.sql');
    const data = await required(dir, 'data.sql');

    // Restores pair a full backup with a newer daily one, so the backup has to
    // say what it is and when it was taken. Only daily backups require it:
    // full backups made before backup-info existed are still restorable.
    const info = await readBackupInfo(dir);
    if (info === undefined) {
        if (dump === 'small') throw new Error(`${BACKUP_INFO} is missing; daily backups must record when they were taken`);
    } else {
        if (info.dump !== dump) throw new Error(`${BACKUP_INFO} says this is a ${info.dump ?? 'unknown'} backup, not ${dump}`);
        if (!TAKEN_AT.test(info.taken_at ?? '')) throw new Error(`${BACKUP_INFO} has no valid taken_at (expected UTC like 2026-10-15T09:23:05Z)`);
    }

    const rows = countCopyRows(data);

    const mustHaveRows = dump === 'full' ? ['User', 'Site', 'EnergyData'] : ['User', 'Site'];
    for (const table of mustHaveRows) {
        if (!rows[table]) throw new Error(`data.sql has no rows for ${table}`);
    }
    if (dump === 'full') return rows;

    if ('EnergyData' in rows) throw new Error('EnergyData was not excluded from the daily data dump');
    const recent = (await required(dir, RECENT_ENERGY)).split('\n').filter((line) => line.length > 0);
    const header = recent[0]?.split(',') ?? [];
    if (!header.includes('timestamp') || !header.includes('site_id')) {
        throw new Error(`${RECENT_ENERGY} does not start with the EnergyData header`);
    }
    return { ...rows, 'EnergyData (recent)': recent.length - 1 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const [dir, dump] = process.argv.slice(2);
    if (dump !== 'full' && dump !== 'small') {
        console.error('Usage: verify-db-backup.ts <dir> <full|small>');
        process.exitCode = 1;
    } else {
        verifyBackupDirectory(dir, dump)
            .then((rows) => {
                console.log('Backup verified. Rows per table:');
                for (const [table, count] of Object.entries(rows)) console.log(`  ${table}: ${count}`);
            })
            .catch((error: unknown) => {
                console.error(error instanceof Error ? error.message : 'Backup verification failed');
                process.exitCode = 1;
            });
    }
}
