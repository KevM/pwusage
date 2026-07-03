import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withImportLock } from './import-lock';

describe('withImportLock', () => {
    const siteRepo = {
        acquireImportLock: vi.fn(),
        releaseImportLock: vi.fn(),
    };

    beforeEach(() => {
        vi.clearAllMocks();
        siteRepo.acquireImportLock.mockResolvedValue(true);
        siteRepo.releaseImportLock.mockResolvedValue(true);
    });

    it('runs the callback after acquiring the lock and releases afterward', async () => {
        const result = await withImportLock(
            siteRepo,
            { siteId: 'site-1', lockDurationMs: 60000, minIntervalMs: 1000, logLabel: 'Test' },
            async () => 'done'
        );

        expect(result).toEqual({ status: 'acquired', value: 'done' });
        expect(siteRepo.acquireImportLock).toHaveBeenCalledWith({
            siteId: 'site-1',
            lockId: expect.any(String),
            lockDurationMs: 60000,
            minIntervalMs: 1000,
            force: undefined,
        });
        expect(siteRepo.releaseImportLock).toHaveBeenCalledWith('site-1', expect.any(String));
    });

    it('does not run the callback when the lock is not acquired', async () => {
        siteRepo.acquireImportLock.mockResolvedValue(false);
        const callback = vi.fn();

        const result = await withImportLock(
            siteRepo,
            { siteId: 'site-1', lockDurationMs: 60000, logLabel: 'Test' },
            callback
        );

        expect(result).toEqual({ status: 'not-acquired' });
        expect(callback).not.toHaveBeenCalled();
        expect(siteRepo.releaseImportLock).not.toHaveBeenCalled();
    });

    it('still releases the lock when the callback throws', async () => {
        await expect(withImportLock(
            siteRepo,
            { siteId: 'site-1', lockDurationMs: 60000, logLabel: 'Test' },
            async () => { throw new Error('boom'); }
        )).rejects.toThrow('boom');

        expect(siteRepo.releaseImportLock).toHaveBeenCalledWith('site-1', expect.any(String));
    });
});
