import 'dotenv/config';
import { createReadStream } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { put } from '@vercel/blob';

export async function uploadDatabaseBackup(filename: string, token: string | undefined): Promise<void> {
    if (!token) throw new Error('BACKUP_BLOB_READ_WRITE_TOKEN is required for private backups');
    if (!filename) throw new Error('A database backup filename is required');

    await put(`db-backup/${basename(filename)}`, createReadStream(filename), {
        access: 'private',
        token,
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    uploadDatabaseBackup(process.argv[2], process.env.BACKUP_BLOB_READ_WRITE_TOKEN)
        .then(() => console.log('Private database backup uploaded successfully'))
        .catch((error: unknown) => {
            console.error(error instanceof Error ? error.message : 'Private database backup upload failed');
            process.exitCode = 1;
        });
}
