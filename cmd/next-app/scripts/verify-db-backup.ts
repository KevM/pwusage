import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// pg_dump writes `COPY public."User" (...) FROM stdin;`; tolerate quoted or bare names.
const COPY_HEADER = /^COPY\s+(?:"?public"?\.)?"?([^"\s(]+)"?\s*(?:\(.*\))?\s+FROM\s+stdin;$/;
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
 * Day records in a pg_dump data file that hold samples. An `empty` record (Tesla
 * answered the day with no samples) has no summary rows, so it is not counted.
 */
export function countDayRecordsWithSamples(data: string): number {
    let status: number | undefined;
    let copying = false;
    let count = 0;
    for (const line of data.split('\n')) {
        if (!copying) {
            const match = COPY_HEADER.exec(line);
            if (match?.[1] !== 'EnergyDayArchive') continue;
            copying = true;
            const columns = /\((.*)\)/.exec(line)?.[1].split(',').map((c) => c.trim().replace(/"/g, '')) ?? [];
            status = columns.indexOf('status');
        } else if (line === '\\.') {
            copying = false;
        } else if (status === undefined || status < 0 || line.split('\t')[status] !== 'empty') {
            count += 1;
        }
    }
    return count;
}

/**
 * Checks an unpacked backup before it is uploaded (and before a restore), so an
 * empty, truncated or mis-scoped dump fails the run instead of being stored as a
 * good backup. Every backup is a complete dump.
 */
export async function verifyBackupDirectory(dir: string): Promise<Record<string, number>> {
    await required(dir, 'roles.sql');
    await required(dir, 'schema.sql');
    const data = await required(dir, 'data.sql');

    // Backups made before backup-info existed are still restorable.
    const info = await readBackupInfo(dir);
    if (info !== undefined && !TAKEN_AT.test(info.taken_at ?? '')) {
        throw new Error(`${BACKUP_INFO} has no valid taken_at (expected UTC like 2026-10-15T09:23:05Z)`);
    }
    // Daily backups before 2026-10-27 skipped raw EnergyData history; on their own they are incomplete.
    if (info?.dump === 'small') {
        throw new Error('This is a partial daily backup from before 2026-10-27 (no raw EnergyData history). Restore it together with a full backup using restore-db-backup.sh from that time; see docs/database-backups.md.');
    }

    const rows = countCopyRows(data);

    for (const table of ['User', 'Site']) {
        if (!rows[table]) throw new Error(`data.sql has no rows for ${table}`);
    }
    // Day records with samples carry their totals in summary rows; records without any were cut off.
    const recordsWithSamples = rows.EnergyDayArchive ? countDayRecordsWithSamples(data) : 0;
    if (recordsWithSamples && !rows.EnergyDaySummary) throw new Error('data.sql has day records but no rows for EnergyDaySummary');
    // Backups taken before the single compact store also hold raw EnergyData history.
    if (!recordsWithSamples && !rows.EnergyData) throw new Error('data.sql has no energy history (EnergyDayArchive)');
    return rows;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const [dir] = process.argv.slice(2);
    if (!dir) {
        console.error('Usage: verify-db-backup.ts <dir>');
        process.exitCode = 1;
    } else {
        verifyBackupDirectory(dir)
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
