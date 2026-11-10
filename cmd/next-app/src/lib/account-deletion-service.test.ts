import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    invalidateCache: vi.fn(),
    repairConnection: vi.fn(),
    createClient: vi.fn(),
    restoreBattery: vi.fn(),
    getSitesForDeletion: vi.fn(),
    repoDelete: vi.fn(),
    logEvent: vi.fn(),
}));

vi.mock('./site-repo', () => ({
    SiteRepo: class {
        invalidateCache = mocks.invalidateCache;
        repairConnection = mocks.repairConnection;
    },
}));
vi.mock('./battery-hold-repo', () => ({
    BatteryHoldRepo: class {},
}));
vi.mock('./battery-hold-service', () => ({
    createSiteTeslaClient: mocks.createClient,
    restoreBattery: mocks.restoreBattery,
}));
vi.mock('./account-deletion-repo', () => {
    class ActiveBatterySaverError extends Error {}
    return {
        ActiveBatterySaverError,
        AccountDeletionRepo: class {
            getSitesForDeletion = mocks.getSitesForDeletion;
            deleteAccount = mocks.repoDelete;
        },
    };
});
vi.mock('./observability', () => ({
    accountFingerprint: (userId: string) => `hash-of-${userId}`,
    logEvent: mocks.logEvent,
}));

import { ActiveBatterySaverError } from './account-deletion-repo';
import { deleteAccount, getAccountDeletionSites } from './account-deletion-service';

describe('account deletion service', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getSitesForDeletion.mockResolvedValue([
            { id: 'site-1', name: 'Home', shared: false, hasOtherUsableMember: false, activeHoldOriginalReserve: null },
        ]);
        mocks.createClient.mockResolvedValue({ tesla: true });
        mocks.repoDelete.mockResolvedValue({ deletedSiteIds: ['site-1'], survivingSiteIds: [] });
        mocks.repairConnection.mockResolvedValue(null);
    });

    it('lists sites with shared status and the reserve Battery Saver would restore', async () => {
        mocks.getSitesForDeletion.mockResolvedValue([
            { id: 'site-1', name: 'Home', shared: false, hasOtherUsableMember: false, activeHoldOriginalReserve: 20 },
            { id: 'site-2', name: 'Cabin', shared: true, hasOtherUsableMember: true, activeHoldOriginalReserve: 30 },
        ]);
        await expect(getAccountDeletionSites('user-1')).resolves.toEqual([
            { id: 'site-1', name: 'Home', shared: false, batterySaverRestoreReserve: 20 },
            { id: 'site-2', name: 'Cabin', shared: true, batterySaverRestoreReserve: null },
        ]);
    });

    it('deletes without touching Tesla when Battery Saver is off', async () => {
        await expect(deleteAccount('user-1')).resolves.toEqual({
            status: 'deleted',
            sitesDeleted: 1,
            sitesRetained: 0,
        });
        expect(mocks.createClient).not.toHaveBeenCalled();
        expect(mocks.invalidateCache).toHaveBeenCalledWith('site-1');
    });

    it('skips Battery Saver restore and repairs connection when another usable member remains on a shared site', async () => {
        mocks.getSitesForDeletion.mockResolvedValue([
            { id: 'site-shared', name: 'Home', shared: true, hasOtherUsableMember: true, activeHoldOriginalReserve: 20 },
        ]);
        mocks.repoDelete.mockResolvedValue({ deletedSiteIds: [], survivingSiteIds: ['site-shared'] });

        await expect(deleteAccount('user-1')).resolves.toEqual({
            status: 'deleted',
            sitesDeleted: 0,
            sitesRetained: 1,
        });
        expect(mocks.restoreBattery).not.toHaveBeenCalled();
        expect(mocks.repairConnection).toHaveBeenCalledWith('site-shared');
        expect(mocks.invalidateCache).toHaveBeenCalledWith('site-shared');
    });

    it('logs a fingerprint and site counts, never the raw user id', async () => {
        await deleteAccount('user-1');
        expect(mocks.logEvent).toHaveBeenCalledWith('info', 'user.account-deletion.completed', {
            accountId: 'hash-of-user-1',
            sitesDeleted: 1,
            sitesRetained: 0,
        });
        expect(JSON.stringify(mocks.logEvent.mock.calls)).not.toContain('"user-1"');
    });

    it.each([['ok'], ['reserve_changed'], ['no_active_hold']])('deletes after a %s restore', async status => {
        mocks.getSitesForDeletion.mockResolvedValue([
            { id: 'site-1', name: 'Home', shared: false, hasOtherUsableMember: false, activeHoldOriginalReserve: 20 },
        ]);
        mocks.restoreBattery.mockResolvedValue({ status });
        await expect(deleteAccount('user-1')).resolves.toMatchObject({ status: 'deleted' });
        expect(mocks.restoreBattery).toHaveBeenCalledWith(expect.objectContaining({
            siteId: 'site-1',
            actorUserId: 'user-1',
            reason: 'manual',
        }));
    });

    it('keeps the account when Tesla needs reconnecting', async () => {
        mocks.getSitesForDeletion.mockResolvedValue([
            { id: 'site-1', name: 'Home', shared: false, hasOtherUsableMember: false, activeHoldOriginalReserve: 20 },
        ]);
        mocks.restoreBattery.mockResolvedValue({ status: 'needs_reauth' });
        await expect(deleteAccount('user-1')).resolves.toEqual({ status: 'needs_reconnect' });
        expect(mocks.repoDelete).not.toHaveBeenCalled();
    });

    it('keeps the account when no Tesla client can be built', async () => {
        mocks.getSitesForDeletion.mockResolvedValue([
            { id: 'site-1', name: 'Home', shared: false, hasOtherUsableMember: false, activeHoldOriginalReserve: 20 },
        ]);
        mocks.createClient.mockResolvedValue(null);
        await expect(deleteAccount('user-1')).resolves.toEqual({ status: 'needs_reconnect' });
        expect(mocks.repoDelete).not.toHaveBeenCalled();
    });

    it('keeps the account when the restore cannot be confirmed', async () => {
        mocks.getSitesForDeletion.mockResolvedValue([
            { id: 'site-1', name: 'Home', shared: false, hasOtherUsableMember: false, activeHoldOriginalReserve: 20 },
        ]);
        mocks.restoreBattery.mockResolvedValue({ status: 'error', message: 'uncertain' });
        await expect(deleteAccount('user-1')).resolves.toEqual({ status: 'battery_saver_pending' });
        expect(mocks.repoDelete).not.toHaveBeenCalled();
    });

    it('reports a session that started during deletion', async () => {
        mocks.repoDelete.mockRejectedValue(new ActiveBatterySaverError());
        await expect(deleteAccount('user-1')).resolves.toEqual({ status: 'battery_saver_pending' });
    });

    it('rethrows database failures', async () => {
        mocks.repoDelete.mockRejectedValue(new Error('connection lost'));
        await expect(deleteAccount('user-1')).rejects.toThrow('connection lost');
        expect(mocks.logEvent).toHaveBeenCalledWith('error', 'user.account-deletion.failed', expect.anything());
    });
});
