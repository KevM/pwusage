import { AccountDeletionRepo, ActiveBatterySaverError } from './account-deletion-repo';
import { BatteryHoldRepo } from './battery-hold-repo';
import { createSiteTeslaClient, restoreBattery, type RestoreResult } from './battery-hold-service';
import { accountFingerprint, logEvent } from './observability';
import { SiteRepo } from './site-repo';

export interface AccountDeletionSite {
    id: string;
    name: string;
    /** True when another member also belongs to this site, so the site and its history will stay. */
    shared: boolean;
    /** The reserve Battery Saver will restore on deletion; null when no restore is needed. */
    batterySaverRestoreReserve: number | null;
}

export type AccountDeletionResult =
    | { status: 'deleted'; sitesDeleted: number; sitesRetained: number }
    | { status: 'needs_reconnect' }
    | { status: 'battery_saver_pending' };

export async function getAccountDeletionSites(userId: string): Promise<AccountDeletionSite[]> {
    const overview = await new AccountDeletionRepo().getSitesForDeletion(userId);
    return overview.map(site => ({
        id: site.id,
        name: site.name,
        shared: site.shared,
        batterySaverRestoreReserve: site.hasOtherUsableMember ? null : site.activeHoldOriginalReserve,
    }));
}

async function restoreSiteBatterySaver(siteId: string, userId: string, repo: BatteryHoldRepo): Promise<RestoreResult> {
    const client = await createSiteTeslaClient(siteId);
    if (!client) return { status: 'needs_reauth' };
    return restoreBattery({ client, repo, siteId, actorUserId: userId, reason: 'manual' });
}

/**
 * Restores any active Battery Saver session on sites where no other usable member
 * remains, deletes the account in one transaction, and repairs the Tesla connection
 * for any surviving shared sites.
 */
export async function deleteAccount(userId: string): Promise<AccountDeletionResult> {
    const accountId = accountFingerprint(userId);
    const deletionRepo = new AccountDeletionRepo();
    const siteRepo = new SiteRepo();
    const holdRepo = new BatteryHoldRepo();

    for (const site of await deletionRepo.getSitesForDeletion(userId)) {
        if (site.activeHoldOriginalReserve === null || site.hasOtherUsableMember) continue;
        const restore = await restoreSiteBatterySaver(site.id, userId, holdRepo);
        if (restore.status === 'needs_reauth') {
            logEvent('warn', 'user.account-deletion.blocked', { accountId, reason: 'needs_reconnect' });
            return { status: 'needs_reconnect' };
        }
        if (restore.status === 'error') {
            logEvent('warn', 'user.account-deletion.blocked', { accountId, reason: 'restore_unconfirmed' });
            return { status: 'battery_saver_pending' };
        }
    }

    let deletedSiteIds: string[];
    let survivingSiteIds: string[];
    try {
        ({ deletedSiteIds, survivingSiteIds } = await deletionRepo.deleteAccount(userId));
    } catch (error) {
        if (error instanceof ActiveBatterySaverError) {
            logEvent('warn', 'user.account-deletion.blocked', { accountId, reason: 'battery_saver_started' });
            return { status: 'battery_saver_pending' };
        }
        logEvent('error', 'user.account-deletion.failed', { accountId, error });
        throw error;
    }

    for (const siteId of survivingSiteIds) {
        await siteRepo.repairConnection(siteId);
        siteRepo.invalidateCache(siteId);
    }
    for (const siteId of deletedSiteIds) {
        siteRepo.invalidateCache(siteId);
    }

    logEvent('info', 'user.account-deletion.completed', {
        accountId,
        sitesDeleted: deletedSiteIds.length,
        sitesRetained: survivingSiteIds.length,
    });
    return {
        status: 'deleted',
        sitesDeleted: deletedSiteIds.length,
        sitesRetained: survivingSiteIds.length,
    };
}
