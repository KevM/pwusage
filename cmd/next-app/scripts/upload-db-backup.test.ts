import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReadStream } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { put } from '@vercel/blob';
import { uploadDatabaseBackup } from './upload-db-backup';

vi.mock('@vercel/blob', () => ({ put: vi.fn() }));
afterEach(() => vi.clearAllMocks());

it('requires a dedicated backup token instead of falling back to public storage', async () => {
    vi.stubEnv('BLOB_READ_WRITE_TOKEN', 'public-store-token');
    try {
        await expect(uploadDatabaseBackup('backup.zip', undefined, 'daily')).rejects.toThrow('BACKUP_BLOB_READ_WRITE_TOKEN');
        expect(put).not.toHaveBeenCalled();
    } finally {
        vi.unstubAllEnvs();
    }
});

it('uploads the backup bytes with private access and propagates upload errors', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pwusage-backup-test-'));
    const filename = join(dir, 'backup.zip');
    await writeFile(filename, 'backup-fixture');
    let uploaded = '';
    vi.mocked(put).mockImplementationOnce(async (_pathname, body, options) => {
        expect(options.access).toBe('private');
        expect(options.token).toBe('private-store-token');
        expect(_pathname).toBe('db-backup/pre-migration/backup.zip');
        for await (const chunk of body as ReadStream) uploaded += chunk.toString();
        throw new Error('Storage unavailable');
    });
    try {
        await expect(uploadDatabaseBackup(filename, 'private-store-token', 'pre-migration')).rejects.toThrow('Storage unavailable');
        expect(uploaded).toBe('backup-fixture');
    } finally {
        await rm(dir, { recursive: true });
    }
});

it('rejects an unknown backup kind before uploading anything', async () => {
    await expect(uploadDatabaseBackup('backup.zip', 'private-store-token', 'hourly')).rejects.toThrow('Unknown backup kind');
    expect(put).not.toHaveBeenCalled();
});
