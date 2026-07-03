import type { SiteRepo } from './site-repo';

type ImportLockRepo = Pick<SiteRepo, 'acquireImportLock' | 'releaseImportLock'>;

export interface ImportLockOptions {
    siteId: string;
    lockDurationMs?: number;
    force?: boolean;
    minIntervalMs?: number;
    logLabel: string;
}

export type ImportLockResult<T> =
    | { status: 'not-acquired' }
    | { status: 'acquired'; value: T };

export async function withImportLock<T>(
    siteRepo: ImportLockRepo,
    options: ImportLockOptions,
    callback: () => Promise<T>
): Promise<ImportLockResult<T>> {
    const lockId = crypto.randomUUID();
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

    try {
        return { status: 'acquired', value: await callback() };
    } finally {
        try {
            await siteRepo.releaseImportLock(options.siteId, lockId);
        } catch (error) {
            console.error(`[${options.logLabel}] Failed to release DB import lock for site ${options.siteId}:`, error);
        }
    }
}
