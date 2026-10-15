import 'dotenv/config';
import { createReadStream } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { put } from '@vercel/blob';
import { backupKind } from './db-backup-kinds';

export async function uploadDatabaseBackup(filename: string, token: string | undefined, kind: string): Promise<string> {
    const { folder } = backupKind(kind);
    if (!token) throw new Error('BACKUP_BLOB_READ_WRITE_TOKEN is required for private backups');
    if (!filename) throw new Error('A database backup filename is required');

    const pathname = `${folder}${basename(filename)}`;
    await put(pathname, createReadStream(filename), {
        access: 'private',
        token,
    });
    return pathname;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    uploadDatabaseBackup(process.argv[2], process.env.BACKUP_BLOB_READ_WRITE_TOKEN, process.argv[3] ?? '')
        .then((pathname) => console.log(`Private database backup uploaded to ${pathname}`))
        .catch((error: unknown) => {
            console.error(error instanceof Error ? error.message : 'Private database backup upload failed');
            process.exitCode = 1;
        });
}
