import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Importer } from './importer';
import { SiteRepo } from './site-repo';
import { UserRepo } from './user-repo';
import { TariffRepo } from './tariff-repo';
import type { TeslaClient, EnergySiteInfo, TariffV2 } from './tesla-client';
import fixtureJson from './__fixtures__/tesla-tariff-two-season.json';
import { TeslaTariffSyncRepo, type TeslaSyncAttempt } from './tesla-tariff-sync-repo';

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

// After Tesla's stored plan is read, each `unconfirmed` Sync to Tesla attempt is settled against the
// plan that attempt sent (its `sent_content`), never against PWUsage's plan as it is today.
describe('Importer.ensureSite Sync to Tesla settlement', () => {
    const fixture = fixtureJson as unknown as TariffV2;
    // Same plan shape as the fixture, with one Summer rate changed: what a send of an older PWUsage plan looks like.
    const changedFixture = structuredClone(fixture);
    changedFixture.energy_charges.Summer.rates.ON_PEAK = 0.55;
    const info = { id: 'hw-1', site_name: 'Home', installation_time_zone: 'UTC', tariff_content_v2: fixture } as EnergySiteInfo;
    let listUnconfirmed: ReturnType<typeof vi.spyOn>;
    let confirmUnconfirmed: ReturnType<typeof vi.spyOn>;
    let getSiteJson: ReturnType<typeof vi.spyOn>;

    function attempt(id: number, sentContent: unknown): TeslaSyncAttempt {
        return {
            id,
            siteId: 's1',
            userId: 'u1',
            fingerprint: `fp-${id}`,
            selectionId: null,
            replacedTeslaTariffId: null,
            sentContent,
            status: 'unconfirmed',
            teslaResponse: null,
            createdAt: '2026-11-01T00:00:00.000Z',
            finishedAt: null,
        };
    }

    beforeEach(() => {
        vi.spyOn(SiteRepo.prototype, 'getSite').mockResolvedValue(undefined);
        getSiteJson = vi.spyOn(SiteRepo.prototype, 'getSiteJson').mockResolvedValue({});
        vi.spyOn(SiteRepo.prototype, 'upsertSite').mockResolvedValue('UTC');
        vi.spyOn(SiteRepo.prototype, 'invalidateCache').mockReturnValue(undefined);
        vi.spyOn(SiteRepo.prototype, 'needsInitialImport').mockResolvedValue(false);
        vi.spyOn(UserRepo.prototype, 'updateLastChecked').mockResolvedValue(undefined);
        vi.spyOn(TariffRepo.prototype, 'addTariffVersion').mockResolvedValue(undefined as never);
        vi.spyOn(console, 'log').mockImplementation(() => {});
        listUnconfirmed = vi.spyOn(TeslaTariffSyncRepo.prototype, 'listUnconfirmed').mockResolvedValue([]);
        confirmUnconfirmed = vi.spyOn(TeslaTariffSyncRepo.prototype, 'confirmUnconfirmed').mockResolvedValue(true);
    });
    afterEach(() => vi.restoreAllMocks());

    const ensure = () => new Importer({ getEnergySiteInfo: vi.fn().mockResolvedValue(info) } as unknown as TeslaClient).ensureSite('s1');

    it('does nothing extra when no attempt is unconfirmed', async () => {
        listUnconfirmed.mockResolvedValue([]);
        await ensure();
        expect(confirmUnconfirmed).not.toHaveBeenCalled();
    });

    it('confirms an unconfirmed attempt whose sent payload matches the plan Tesla stores', async () => {
        listUnconfirmed.mockResolvedValue([attempt(11, fixture)]);
        await ensure();
        expect(confirmUnconfirmed).toHaveBeenCalledTimes(1);
        expect(confirmUnconfirmed).toHaveBeenCalledWith(11);
    });

    it('leaves an unconfirmed attempt unconfirmed when the sent payload differs from Tesla, even if it matches today\'s PWUsage plan', async () => {
        // The PWUsage plan changed after the send: Tesla stores the plan that matches today's plan, not the sent one.
        listUnconfirmed.mockResolvedValue([attempt(11, changedFixture)]);
        await ensure();
        expect(confirmUnconfirmed).not.toHaveBeenCalled();
    });

    it('confirms only the attempt whose sent payload matches', async () => {
        listUnconfirmed.mockResolvedValue([attempt(11, changedFixture), attempt(12, fixture)]);
        await ensure();
        expect(confirmUnconfirmed).toHaveBeenCalledTimes(1);
        expect(confirmUnconfirmed).toHaveBeenCalledWith(12);
    });

    it('skips a sent payload that is not a usable TariffV2', async () => {
        listUnconfirmed.mockResolvedValue([attempt(11, {}), attempt(12, null), attempt(13, 'not a tariff')]);
        await ensure();
        expect(confirmUnconfirmed).not.toHaveBeenCalled();
    });

    it('does not confirm an attempt for a day-specific plan', async () => {
        const daySpecific = structuredClone(fixture);
        daySpecific.seasons.Summer.tou_periods.ON_PEAK.periods.push({
            fromDayOfWeek: 4, toDayOfWeek: 4, fromHour: 6, fromMinute: 0, toHour: 8, toMinute: 0,
        });
        listUnconfirmed.mockResolvedValue([attempt(11, daySpecific)]);
        await ensure();
        expect(confirmUnconfirmed).not.toHaveBeenCalled();
    });

    it('settles an attempt when the imported content is unchanged', async () => {
        // Tesla's plan was imported earlier (while the attempt was still sending, or the first settle failed).
        getSiteJson.mockResolvedValue(info);
        listUnconfirmed.mockResolvedValue([attempt(11, fixture)]);
        await ensure();
        expect(confirmUnconfirmed).toHaveBeenCalledWith(11);
    });

    it('never fails the import when settling throws', async () => {
        listUnconfirmed.mockRejectedValue(new Error('db down'));
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        await expect(ensure()).resolves.toBeUndefined();
    });
});
