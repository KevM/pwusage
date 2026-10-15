import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { del, list } from '@vercel/blob';
import { backupKind } from './db-backup-kinds';

export type StoredBackup = { pathname: string; url: string; uploadedAt: Date };
type ListPage = { blobs: StoredBackup[]; hasMore: boolean; cursor?: string };
type ListBlobs = (options: { prefix: string; token: string; cursor?: string }) => Promise<ListPage>;
type DeleteBlobs = (urls: string[], options: { token: string }) => Promise<void>;

/** Backups directly inside `folder`, newest first, after the newest `keep`. */
export function selectExpiredBackups(blobs: StoredBackup[], folder: string, keep: number): StoredBackup[] {
    return backupsIn(blobs, folder).slice(keep);
}

function backupsIn(blobs: StoredBackup[], folder: string): StoredBackup[] {
    return blobs
        .filter((blob) => blob.pathname.startsWith(folder)
            && !blob.pathname.slice(folder.length).includes('/')
            && blob.pathname.endsWith('.zip'))
        .sort((a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime() || b.pathname.localeCompare(a.pathname));
}

/**
 * Deletes a kind's backups beyond its retention. It refuses to delete anything
 * unless the folder's newest backup is fresh: the workflow only prunes after
 * this run's upload, and the check makes that ordering hold even if the
 * workflow is edited, so a failing dump can never rotate out good backups.
 */
export async function pruneBackups(options: {
    kind: string;
    token: string | undefined;
    now?: Date;
    keep?: number;
    freshWithinHours?: number;
    listBlobs?: ListBlobs;
    deleteBlobs?: DeleteBlobs;
}): Promise<string[]> {
    const config = backupKind(options.kind);
    const keep = options.keep ?? config.keep;
    const token = options.token;
    if (!token) throw new Error('BACKUP_BLOB_READ_WRITE_TOKEN is required to prune backups');
    if (!Number.isInteger(keep) || keep < 1) throw new Error('Retention must keep at least one backup');
    const listBlobs: ListBlobs = options.listBlobs ?? ((listOptions) => list(listOptions));
    const deleteBlobs: DeleteBlobs = options.deleteBlobs ?? ((urls, deleteOptions) => del(urls, deleteOptions));
    const now = options.now ?? new Date();
    const freshWithinHours = options.freshWithinHours ?? 6;

    const blobs: StoredBackup[] = [];
    let cursor: string | undefined;
    do {
        const page = await listBlobs({ prefix: config.folder, token, cursor });
        blobs.push(...page.blobs);
        if (page.hasMore && !page.cursor) throw new Error('Backup listing reported more pages without a cursor');
        cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);

    const backups = backupsIn(blobs, config.folder);
    if (backups.length === 0) throw new Error(`No backups found in ${config.folder}; refusing to prune`);
    const newestAgeHours = (now.getTime() - backups[0].uploadedAt.getTime()) / 3_600_000;
    if (newestAgeHours > freshWithinHours) {
        throw new Error(`The newest backup in ${config.folder} is ${Math.round(newestAgeHours)} hours old; refusing to prune without a fresh backup`);
    }

    const expired = backups.slice(keep);
    if (expired.length > 0) await deleteBlobs(expired.map((blob) => blob.url), { token });
    return expired.map((blob) => blob.pathname);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    pruneBackups({ kind: process.argv[2] ?? '', token: process.env.BACKUP_BLOB_READ_WRITE_TOKEN })
        .then((deleted) => {
            console.log(deleted.length === 0 ? 'No backups past retention' : `Deleted ${deleted.length} expired backups:`);
            for (const pathname of deleted) console.log(`  ${pathname}`);
        })
        .catch((error: unknown) => {
            console.error(error instanceof Error ? error.message : 'Backup pruning failed');
            process.exitCode = 1;
        });
}
