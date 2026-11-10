import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Importer } from './importer';
import { SiteRepo } from './site-repo';
import { UserRepo } from './user-repo';
import { TariffRepo } from './tariff-repo';
import type { TeslaClient, EnergySiteInfo } from './tesla-client';

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
