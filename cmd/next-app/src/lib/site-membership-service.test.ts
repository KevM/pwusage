import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SiteMembershipService } from './site-membership-service';
import type { FleetProduct, TeslaClient } from './tesla-client';
import type { SiteMembershipJoinRepo } from './site-membership-join-repo';
import type { SiteRepo } from './site-repo';
import type { Importer } from './importer';

const product = (id: number) => ({ energy_site_id: id, resource_type: 'battery' }) as FleetProduct;

describe('SiteMembershipService login reconciliation', () => {
    const client = { getEnergySiteInfo: vi.fn() };
    const importer = { ensureSite: vi.fn() };
    const members = { membersForUser: vi.fn(), membersForHardware: vi.fn(), commitDecision: vi.fn(), markChecked: vi.fn() };
    const sites = { touchMember: vi.fn(), needsInitialImport: vi.fn(), removeMemberIfMissing: vi.fn(), repairConnection: vi.fn() };
    const clientForUser = vi.fn();
    const fetchedAt = new Date('2026-11-09T12:00:00Z');
    const service = () => new SiteMembershipService(client as unknown as TeslaClient,
        importer as unknown as Importer, members as unknown as SiteMembershipJoinRepo,
        sites as unknown as SiteRepo, clientForUser);

    beforeEach(() => {
        vi.resetAllMocks();
        client.getEnergySiteInfo.mockResolvedValue({ id: 'hardware-1', site_name: 'Home' });
        members.membersForUser.mockResolvedValue([]);
        members.membersForHardware.mockResolvedValue([]);
        sites.touchMember.mockResolvedValue(true);
        sites.needsInitialImport.mockResolvedValue(false);
        sites.removeMemberIfMissing.mockResolvedValue(true);
    });

    it('touches a listed mapping without a site-info call', async () => {
        members.membersForUser.mockResolvedValue([{ site_id: 'home', tesla_energy_site_id: '10' }]);
        expect(await service().syncLogin('user', [product(10)], fetchedAt)).toEqual(['home']);
        expect(sites.touchMember).toHaveBeenCalledWith('home', 'user', '10', fetchedAt);
        expect(client.getEnergySiteInfo).not.toHaveBeenCalled();
        expect(importer.ensureSite).not.toHaveBeenCalled();
    });

    it('retries an unfinished fresh-site import on the next login', async () => {
        members.membersForUser.mockResolvedValue([{ site_id: '10', tesla_energy_site_id: '10' }]);
        sites.needsInitialImport.mockResolvedValue(true);
        await service().syncLogin('user', [product(10)], fetchedAt);
        expect(importer.ensureSite).toHaveBeenCalledWith('10');
    });

    it('immediately removes an observed member whose live product list omits their mapped site', async () => {
        const departed = { site_id: 'old-home', user_id: 'seller', tesla_energy_site_id: '10',
            is_active: true, refresh_token: 'r', auth_status: 'active', tesla_refresh_state: 'ready' };
        members.membersForHardware.mockResolvedValueOnce([departed]).mockResolvedValueOnce([]);
        members.commitDecision.mockResolvedValue({ kind: 'fresh', siteId: '20' });
        clientForUser.mockResolvedValue({ getProducts: async () => [] });

        expect(await service().syncLogin('buyer', [product(20)], fetchedAt)).toEqual(['20']);
        expect(sites.removeMemberIfMissing).toHaveBeenCalledWith('old-home', 'seller', '10', expect.any(Date));
        expect(members.commitDecision).toHaveBeenCalledWith(expect.objectContaining({
            verifiedSiteId: null, observedMembers: [], teslaId: '20', hardwareId: 'hardware-1',
        }));
        expect(importer.ensureSite).toHaveBeenCalledWith('20');
    });

    it('keeps an observed member who was re-invited under a new Tesla ID for the same hardware', async () => {
        const reinvited = { site_id: 'old-home', user_id: 'owner', tesla_energy_site_id: '10',
            is_active: true, refresh_token: 'r', auth_status: 'active', tesla_refresh_state: 'ready' };
        members.membersForUser.mockImplementation(async (id: string) =>
            id === 'owner' ? [{ site_id: 'old-home', tesla_energy_site_id: '10' }] : []);
        members.membersForHardware.mockResolvedValue([reinvited]);
        members.commitDecision.mockResolvedValue({ kind: 'fresh', siteId: '20' });
        const ownerClient = { getProducts: async () => [product(30)],
            getEnergySiteInfo: vi.fn().mockResolvedValue({ id: 'hardware-1' }) };
        clientForUser.mockResolvedValue(ownerClient);

        await service().syncLogin('buyer', [product(20)], fetchedAt);
        expect(ownerClient.getEnergySiteInfo).toHaveBeenCalledWith('30');
        expect(sites.removeMemberIfMissing).not.toHaveBeenCalledWith('old-home', 'owner', '10', expect.anything());
    });

    it('joins only after an existing member’s own product list confirms their mapping', async () => {
        const member = { site_id: 'home', user_id: 'owner', tesla_energy_site_id: '10',
            is_active: true, refresh_token: 'r', auth_status: 'active', tesla_refresh_state: 'ready' };
        members.membersForHardware.mockResolvedValue([member]);
        members.commitDecision.mockResolvedValue({ kind: 'joined', siteId: 'home' });
        clientForUser.mockResolvedValue({ getProducts: async () => [product(10)] });
        expect(await service().syncLogin('invited', [product(20)], fetchedAt)).toEqual(['home']);
        expect(clientForUser).toHaveBeenCalledWith('owner');
        expect(members.commitDecision).toHaveBeenCalledWith(expect.objectContaining({
            verifiedSiteId: 'home', teslaId: '20', hardwareId: 'hardware-1',
        }));
        expect(importer.ensureSite).not.toHaveBeenCalled();
    });

    it('finishes the initial import when rejoining a retained placeholder that never got a tariff', async () => {
        members.commitDecision.mockResolvedValue({ kind: 'joined', siteId: '20' });
        sites.needsInitialImport.mockResolvedValue(true);
        expect(await service().syncLogin('user', [product(20)], fetchedAt)).toEqual(['20']);
        expect(sites.needsInitialImport).toHaveBeenCalledWith('20');
        expect(importer.ensureSite).toHaveBeenCalledWith('20');
    });

    it('preserves the member during a re-invite with a new Tesla ID', async () => {
        members.membersForUser.mockResolvedValueOnce([{ site_id: 'home', tesla_energy_site_id: '10' }])
            .mockResolvedValueOnce([{ site_id: 'home', tesla_energy_site_id: '20' }]);
        members.commitDecision.mockResolvedValue({ kind: 'reinvite', siteId: 'home' });
        expect(await service().syncLogin('user', [product(20)], fetchedAt)).toEqual(['home']);
        expect(sites.removeMemberIfMissing).not.toHaveBeenCalled();
        expect(importer.ensureSite).not.toHaveBeenCalled();
    });

    it('removes a missing member after an empty successful list', async () => {
        members.membersForUser.mockResolvedValue([{ site_id: 'home', tesla_energy_site_id: '10' }]);
        expect(await service().syncLogin('user', [], fetchedAt)).toEqual([]);
        expect(sites.removeMemberIfMissing).toHaveBeenCalledWith('home', 'user', '10', fetchedAt);
    });

    it('fails login rather than creating a duplicate when a live member check fails', async () => {
        members.membersForHardware.mockResolvedValue([{ site_id: 'home', user_id: 'owner',
            tesla_energy_site_id: '10', is_active: true, refresh_token: 'r',
            auth_status: 'active', tesla_refresh_state: 'ready' }]);
        clientForUser.mockResolvedValue({ getProducts: async () => { throw new Error('Tesla unavailable'); } });
        await expect(service().syncLogin('invited', [product(20)], fetchedAt)).rejects.toThrow('Tesla unavailable');
        expect(members.commitDecision).not.toHaveBeenCalled();
    });
});
