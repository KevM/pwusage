import { describe, expect, it, vi } from 'vitest';
import { pruneBackups, selectExpiredBackups, type StoredBackup } from './db-backup-retention';

const NOW = new Date('2026-10-15T12:00:00Z');
const backup = (pathname: string, hoursAgo: number): StoredBackup => ({
    pathname,
    url: `https://store.example/${pathname}`,
    uploadedAt: new Date(NOW.getTime() - hoursAgo * 3_600_000),
});
const daily = (n: number, hoursAgo: number) => backup(`db-backup/daily/backup-${n}.zip`, hoursAgo);

describe('selectExpiredBackups', () => {
    it('keeps the newest N backups in the folder and expires the rest', () => {
        const blobs = [daily(1, 72), daily(4, 1), daily(2, 48), daily(3, 24)];
        expect(selectExpiredBackups(blobs, 'db-backup/daily/', 2).map((b) => b.pathname))
            .toEqual(['db-backup/daily/backup-2.zip', 'db-backup/daily/backup-1.zip']);
    });

    it('expires nothing when the folder holds N or fewer backups', () => {
        expect(selectExpiredBackups([daily(1, 24), daily(2, 1)], 'db-backup/daily/', 2)).toEqual([]);
    });

    it('ignores legacy root backups, other kinds, nested paths and non-zip files', () => {
        const blobs = [
            daily(1, 1),
            backup('db-backup/backup-2026-10-02_00-00-00.zip', 500),
            backup('db-backup/weekly/backup-w.zip', 400),
            backup('db-backup/daily/nested/backup-x.zip', 300),
            backup('db-backup/daily/notes.txt', 200),
        ];
        expect(selectExpiredBackups(blobs, 'db-backup/daily/', 1)).toEqual([]);
    });
});

function listing(pages: StoredBackup[][]) {
    return vi.fn(async ({ cursor }: { cursor?: string }) => {
        const index = cursor ? Number(cursor) : 0;
        const hasMore = index + 1 < pages.length;
        return { blobs: pages[index], hasMore, cursor: hasMore ? String(index + 1) : undefined };
    });
}

describe('pruneBackups', () => {
    it('reads every page of the listing before choosing what to delete', async () => {
        const listBlobs = listing([[daily(1, 300), daily(2, 200)], [daily(3, 100), daily(4, 1)]]);
        const deleteBlobs = vi.fn(async () => undefined);
        const deleted = await pruneBackups({ kind: 'daily', token: 't', now: NOW, keep: 2, listBlobs, deleteBlobs });
        expect(listBlobs).toHaveBeenCalledTimes(2);
        expect(listBlobs).toHaveBeenCalledWith(expect.objectContaining({ prefix: 'db-backup/daily/', token: 't' }));
        expect(deleted).toEqual(['db-backup/daily/backup-2.zip', 'db-backup/daily/backup-1.zip']);
        expect(deleteBlobs).toHaveBeenCalledWith(
            ['https://store.example/db-backup/daily/backup-2.zip', 'https://store.example/db-backup/daily/backup-1.zip'],
            { token: 't' },
        );
    });

    it('uses the kind\'s retention when no override is given', async () => {
        const blobs = Array.from({ length: 16 }, (_, i) => daily(i, i));
        const deleteBlobs = vi.fn(async () => undefined);
        const deleted = await pruneBackups({ kind: 'daily', token: 't', now: NOW, listBlobs: listing([blobs]), deleteBlobs });
        expect(deleted).toEqual(['db-backup/daily/backup-14.zip', 'db-backup/daily/backup-15.zip']);
    });

    it('refuses to prune unless the newest backup is fresh, so a failed run never rotates out good ones', async () => {
        const deleteBlobs = vi.fn(async () => undefined);
        await expect(pruneBackups({
            kind: 'daily', token: 't', now: NOW, keep: 1,
            listBlobs: listing([[daily(1, 60), daily(2, 30)]]), deleteBlobs,
        })).rejects.toThrow('newest backup');
        expect(deleteBlobs).not.toHaveBeenCalled();
    });

    it('refuses an empty folder', async () => {
        const deleteBlobs = vi.fn(async () => undefined);
        await expect(pruneBackups({ kind: 'weekly', token: 't', now: NOW, listBlobs: listing([[]]), deleteBlobs }))
            .rejects.toThrow('No backups');
        expect(deleteBlobs).not.toHaveBeenCalled();
    });

    it('rejects a missing token or a retention below one', async () => {
        const deleteBlobs = vi.fn(async () => undefined);
        const listBlobs = listing([[daily(1, 1)]]);
        await expect(pruneBackups({ kind: 'daily', token: undefined, now: NOW, listBlobs, deleteBlobs }))
            .rejects.toThrow('BACKUP_BLOB_READ_WRITE_TOKEN');
        await expect(pruneBackups({ kind: 'daily', token: 't', now: NOW, keep: 0, listBlobs, deleteBlobs }))
            .rejects.toThrow('at least one');
        expect(deleteBlobs).not.toHaveBeenCalled();
    });

    it('deletes nothing when listing fails part way', async () => {
        const deleteBlobs = vi.fn(async () => undefined);
        const listBlobs = vi.fn()
            .mockResolvedValueOnce({ blobs: [daily(1, 1)], hasMore: true, cursor: '1' })
            .mockRejectedValueOnce(new Error('Storage unavailable'));
        await expect(pruneBackups({ kind: 'daily', token: 't', now: NOW, keep: 1, listBlobs, deleteBlobs }))
            .rejects.toThrow('Storage unavailable');
        expect(deleteBlobs).not.toHaveBeenCalled();
    });
});
