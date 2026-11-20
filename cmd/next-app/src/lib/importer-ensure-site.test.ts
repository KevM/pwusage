import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Importer } from './importer';
import { SiteRepo } from './site-repo';
import { UserRepo } from './user-repo';
import { TariffRepo } from './tariff-repo';
import type { TeslaClient, EnergySiteInfo, TariffV2 } from './tesla-client';
import fixtureJson from './__fixtures__/tesla-tariff-two-season.json';
import { seasonsFromTeslaContent } from './tesla-tou-sync';
import { TeslaTariffSyncRepo } from './tesla-tariff-sync-repo';
import { TariffTimelineRepo } from './tariff-timeline-repo';

// A fresh-site placeholder stores json = {}, and a failed first import can leave the
// site's json current but its tariff missing; neither may skip the default tariff.
describe('Importer.ensureSite initial tariff', () => {
    const info = { id: 'hw-1', site_name: 'Home', installation_time_zone: 'UTC' } as EnergySiteInfo;
    let addTariffVersion: ReturnType<typeof vi.spyOn>;
    let needsInitialImport: ReturnType<typeof vi.spyOn>;
    let getSiteJson: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.spyOn(SiteRepo.prototype, 'getSite').mockResolvedValue(undefined);
        getSiteJson = vi.spyOn(SiteRepo.prototype, 'getSiteJson');
        vi.spyOn(SiteRepo.prototype, 'upsertSite').mockResolvedValue('UTC');
        vi.spyOn(SiteRepo.prototype, 'invalidateCache').mockReturnValue(undefined);
        needsInitialImport = vi.spyOn(SiteRepo.prototype, 'needsInitialImport');
        vi.spyOn(UserRepo.prototype, 'updateLastChecked').mockResolvedValue(undefined);
        addTariffVersion = vi.spyOn(TariffRepo.prototype, 'addTariffVersion').mockResolvedValue(undefined as never);
        vi.spyOn(console, 'log').mockImplementation(() => {});
    });
    afterEach(() => vi.restoreAllMocks());

    const ensure = () => new Importer({ getEnergySiteInfo: vi.fn().mockResolvedValue(info) } as unknown as TeslaClient).ensureSite('s1');

    it('gives a fresh placeholder (json = {}) its default tariff when Tesla sends none', async () => {
        getSiteJson.mockResolvedValue({});
        needsInitialImport.mockResolvedValue(true);
        await ensure();
        expect(addTariffVersion).toHaveBeenCalledTimes(1);
    });

    it('repairs a site whose json is current but whose first tariff import failed', async () => {
        getSiteJson.mockResolvedValue(info);
        needsInitialImport.mockResolvedValue(true);
        await ensure();
        expect(addTariffVersion).toHaveBeenCalledTimes(1);
    });

    it('still skips the tariff write when nothing changed and a current tariff exists', async () => {
        getSiteJson.mockResolvedValue(info);
        needsInitialImport.mockResolvedValue(false);
        await ensure();
        expect(addTariffVersion).not.toHaveBeenCalled();
    });
});

// After a Tesla tariff is saved, an `unconfirmed` Sync to Tesla attempt is settled against today's plan.
describe('Importer.ensureSite Sync to Tesla settlement', () => {
    const fixture = fixtureJson as unknown as TariffV2;
    const info = { id: 'hw-1', site_name: 'Home', installation_time_zone: 'UTC', tariff_content_v2: fixture } as EnergySiteInfo;
    let settle: ReturnType<typeof vi.spyOn>;
    let latestForSite: ReturnType<typeof vi.spyOn>;
    let loadActive: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.spyOn(SiteRepo.prototype, 'getSite').mockResolvedValue(undefined);
        vi.spyOn(SiteRepo.prototype, 'getSiteJson').mockResolvedValue({});
        vi.spyOn(SiteRepo.prototype, 'upsertSite').mockResolvedValue('UTC');
        vi.spyOn(SiteRepo.prototype, 'invalidateCache').mockReturnValue(undefined);
        vi.spyOn(SiteRepo.prototype, 'needsInitialImport').mockResolvedValue(false);
        vi.spyOn(UserRepo.prototype, 'updateLastChecked').mockResolvedValue(undefined);
        vi.spyOn(TariffRepo.prototype, 'addTariffVersion').mockResolvedValue(undefined as never);
        vi.spyOn(console, 'log').mockImplementation(() => {});
        latestForSite = vi.spyOn(TeslaTariffSyncRepo.prototype, 'latestForSite');
        settle = vi.spyOn(TeslaTariffSyncRepo.prototype, 'settleUnconfirmed').mockResolvedValue(undefined);
        loadActive = vi.spyOn(TariffTimelineRepo.prototype, 'loadActiveActualPlan');
    });
    afterEach(() => vi.restoreAllMocks());

    const ensure = () => new Importer({ getEnergySiteInfo: vi.fn().mockResolvedValue(info) } as unknown as TeslaClient).ensureSite('s1');

    it('does nothing extra when no attempt is unconfirmed', async () => {
        latestForSite.mockResolvedValue(null);
        await ensure();
        expect(loadActive).not.toHaveBeenCalled();
        expect(settle).not.toHaveBeenCalled();
    });

    it('confirms an unconfirmed attempt when the imported plan matches today\'s plan', async () => {
        latestForSite.mockResolvedValue({ status: 'unconfirmed' });
        loadActive.mockResolvedValue({ tariffId: 1, selectionId: null, source: 'manual', name: 'Mine', seasons: seasonsFromTeslaContent(fixture), daySpecific: false });
        await ensure();
        expect(settle).toHaveBeenCalledWith('s1', true);
    });

    it('leaves an unconfirmed attempt alone when the plans differ', async () => {
        latestForSite.mockResolvedValue({ status: 'unconfirmed' });
        loadActive.mockResolvedValue({ tariffId: 1, selectionId: null, source: 'manual', name: 'Mine', seasons: [], daySpecific: false });
        await ensure();
        expect(settle).toHaveBeenCalledWith('s1', false);
    });

    it('does not confirm an unconfirmed attempt for a day-specific plan', async () => {
        latestForSite.mockResolvedValue({ status: 'unconfirmed' });
        loadActive.mockResolvedValue({ tariffId: 1, selectionId: null, source: 'manual', name: 'Mine', seasons: seasonsFromTeslaContent(fixture), daySpecific: true });
        await ensure();
        expect(settle).toHaveBeenCalledWith('s1', false);
    });

    it('never fails the import when settling throws', async () => {
        latestForSite.mockRejectedValue(new Error('db down'));
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        await expect(ensure()).resolves.toBeUndefined();
    });
});
