import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ioSignal, withIoDeadline } from './io-deadline';
import { withImportLock } from './import-lock';

describe('withImportLock', () => {
    const siteRepo = {
        acquireImportLock: vi.fn(),
        acquireImportLockWithPrevious: vi.fn(),
        releaseImportLock: vi.fn(),
        getImportStatus: vi.fn(),
    };

    beforeEach(() => {
        vi.clearAllMocks();
        siteRepo.acquireImportLock.mockResolvedValue(true);
        siteRepo.acquireImportLockWithPrevious.mockResolvedValue({ previousImportAt: 1234 });
        siteRepo.releaseImportLock.mockResolvedValue(true);
        siteRepo.getImportStatus.mockResolvedValue({ isImporting: false, lastImportAt: 1234 });
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

    describe('restoreLastImportOn', () => {
        const options = {
            siteId: 'site-1',
            logLabel: 'Test',
            restoreLastImportOn: (value: unknown) => value === 'failed',
        };

        it('restores the previous stamp when the result counts as a failure', async () => {
            await withImportLock(siteRepo, options, async () => 'failed');
            expect(siteRepo.releaseImportLock).toHaveBeenCalledWith('site-1', expect.any(String), 1234);
        });

        it('restores the stamp captured when acquiring the lock, after any earlier import', async () => {
            siteRepo.acquireImportLockWithPrevious.mockResolvedValue({ previousImportAt: 2345 });
            await withImportLock(siteRepo, options, async () => 'failed');
            expect(siteRepo.getImportStatus).not.toHaveBeenCalled();
            expect(siteRepo.acquireImportLock).not.toHaveBeenCalled();
            expect(siteRepo.releaseImportLock).toHaveBeenCalledWith('site-1', expect.any(String), 2345);
        });

        it('restores a never-imported site to null', async () => {
            siteRepo.acquireImportLockWithPrevious.mockResolvedValue({ previousImportAt: null });
            await withImportLock(siteRepo, options, async () => 'failed');
            expect(siteRepo.releaseImportLock).toHaveBeenCalledWith('site-1', expect.any(String), null);
        });

        it('restores the previous stamp when the callback throws', async () => {
            await expect(withImportLock(siteRepo, options, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
            expect(siteRepo.releaseImportLock).toHaveBeenCalledWith('site-1', expect.any(String), 1234);
        });

        it('keeps the new stamp after success', async () => {
            await withImportLock(siteRepo, options, async () => 'ok');
            expect(siteRepo.releaseImportLock).toHaveBeenCalledWith('site-1', expect.any(String));
        });

        it('does not read the stamp for callers that keep it', async () => {
            await withImportLock(siteRepo, { siteId: 'site-1', logLabel: 'Test' }, async () => 'failed');
            expect(siteRepo.acquireImportLockWithPrevious).not.toHaveBeenCalled();
        });
    });

    it('releases outside an expired request deadline, which would otherwise reject the query', async () => {
        let releaseAborted: boolean | undefined;
        siteRepo.releaseImportLock.mockImplementation(async () => {
            releaseAborted = ioSignal()?.aborted;
            return true;
        });
        const controller = new AbortController();

        await withIoDeadline(1000, () => withImportLock(
            siteRepo,
            { siteId: 'site-1', logLabel: 'Test' },
            async () => { controller.abort(new Error('deadline')); return 'done'; }
        ), controller.signal).catch(() => undefined);
        await vi.waitFor(() => expect(siteRepo.releaseImportLock).toHaveBeenCalled());

        expect(releaseAborted).toBe(false);
    });
});
