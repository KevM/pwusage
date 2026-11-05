import { withIoDeadline } from './io-deadline';
import type { SiteRepo } from './site-repo';

type ImportLockRepo = Pick<SiteRepo, 'acquireImportLock' | 'releaseImportLock' | 'getImportStatus'>;

/** Bounds the release, which must outlive the request deadline that ended the import. */
const LOCK_RELEASE_TIMEOUT_MS = 3000;

export interface ImportLockOptions<T = unknown> {
    siteId: string;
    lockDurationMs?: number;
    force?: boolean;
    minIntervalMs?: number;
    logLabel: string;
    /**
     * Acquiring stamps `last_import_at`, which throttles every caller. When this
     * returns true (a thrown callback always counts) the previous stamp comes back,
     * so a failed attempt doesn't lock out callers with a longer interval.
     */
    restoreLastImportOn?: (value: T) => boolean;
}

export type ImportLockResult<T> =
    | { status: 'not-acquired' }
    | { status: 'acquired'; value: T };

export async function withImportLock<T>(
    siteRepo: ImportLockRepo,
    options: ImportLockOptions<T>,
    callback: () => Promise<T>
): Promise<ImportLockResult<T>> {
    const lockId = crypto.randomUUID();
    const { restoreLastImportOn } = options;
    const previousImportAt = restoreLastImportOn
        ? (await siteRepo.getImportStatus(options.siteId)).lastImportAt
        : 0;
    const acquired = await siteRepo.acquireImportLock({
        siteId: options.siteId,
        lockId,
        lockDurationMs: options.lockDurationMs,
        force: options.force,
        minIntervalMs: options.minIntervalMs,
    });

    if (!acquired) {
        return { status: 'not-acquired' };
    }

    let restoreImportAt = restoreLastImportOn !== undefined;
    try {
        const value = await callback();
        restoreImportAt = restoreLastImportOn?.(value) ?? false;
        return { status: 'acquired', value };
    } finally {
        try {
            await withIoDeadline(LOCK_RELEASE_TIMEOUT_MS, () => restoreImportAt
                ? siteRepo.releaseImportLock(options.siteId, lockId, previousImportAt || null)
                : siteRepo.releaseImportLock(options.siteId, lockId), null);
        } catch (error) {
            console.error(`[${options.logLabel}] Failed to release DB import lock for site ${options.siteId}:`, error);
        }
    }
}
