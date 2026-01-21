import { describe, it, expect, vi, beforeEach } from 'vitest';
import { signSiteToken, verifySiteToken } from './auth-jwt';
import { SiteService } from './site-service';
import { TeslaClient } from './tesla-client';
import { EnergyRepo } from './energy-repo';
import { Site } from './db';

// Mock dependencies
const mockEnergyRepo = {
    getSites: vi.fn(),
} as unknown as EnergyRepo;

describe('Admin Authorization', () => {

    describe('JWT Roles', () => {
        it('should include roles in signed token', () => {
            const token = signSiteToken(['site1'], ['admin']);
            const decoded = verifySiteToken(token);
            expect(decoded).not.toBeNull();
            expect(decoded?.sites).toEqual(['site1']);
            expect(decoded?.roles).toEqual(['admin']);
        });

        it('should default roles to empty array if not provided', () => {
            const token = signSiteToken(['site1']); // No roles
            const decoded = verifySiteToken(token);
            expect(decoded?.roles).toEqual([]);
        });
    });

    describe('SiteService Admin Access', () => {
        let siteService: SiteService;

        beforeEach(() => {
            vi.clearAllMocks();
        });

        it('should allow admin to access any site via validateSiteAccess', async () => {
            const token = signSiteToken(['site1'], ['admin']);
            siteService = new SiteService({
                energyRepo: mockEnergyRepo,
                siteAuthToken: token
            });

            // Admin does not have 'site2' in sites list, but is admin
            const hasAccess = await siteService.validateSiteAccess('site2');
            expect(hasAccess).toBe(true);
        });

        it('should NOT allow non-admin to access other sites', async () => {
            const token = signSiteToken(['site1'], ['user']);
            // Mock API response to also NOT contain 'site2'
            const mockClient = {
                getProducts: vi.fn().mockResolvedValue([{ energy_site_id: 'site1' }])
            };

            siteService = new SiteService({
                energyRepo: mockEnergyRepo,
                siteAuthToken: token,
                teslaClient: mockClient as unknown as Pick<TeslaClient, 'getProducts'>
            });

            const hasAccess = await siteService.validateSiteAccess('site2');
            expect(hasAccess).toBe(false);
        });

        it('should allow non-admin to access their own sites', async () => {
            const token = signSiteToken(['site1'], ['user']);
            siteService = new SiteService({
                energyRepo: mockEnergyRepo,
                siteAuthToken: token
            });

            const hasAccess = await siteService.validateSiteAccess('site1');
            expect(hasAccess).toBe(true);
        });

        it('should return only owned sites for admin in getAuthorizedSites', async () => {
            const allSites: Site[] = [
                { id: 'site1', name: 'Site 1', user_id: 'u1', updated: new Date(), installed: new Date(), timezone: 'UTC', json: {}, billing_start_day: 1 },
                { id: 'site2', name: 'Site 2', user_id: 'u2', updated: new Date(), installed: new Date(), timezone: 'UTC', json: {}, billing_start_day: 1 }
            ];
            vi.mocked(mockEnergyRepo.getSites).mockResolvedValue(allSites);

            // Admin token with ONLY site1
            const token = signSiteToken(['site1'], ['admin']);
            siteService = new SiteService({
                energyRepo: mockEnergyRepo,
                siteAuthToken: token
            });

            const authorizedSites = await siteService.getAuthorizedSites();
            expect(authorizedSites).toHaveLength(1);
            expect(authorizedSites[0].id).toBe('site1');
        });

        it('should return only owned sites for non-admin in getAuthorizedSites', async () => {
            const allSites: Site[] = [
                { id: 'site1', name: 'Site 1', user_id: 'u1', updated: new Date(), installed: new Date(), timezone: 'UTC', json: {}, billing_start_day: 1 },
                { id: 'site2', name: 'Site 2', user_id: 'u2', updated: new Date(), installed: new Date(), timezone: 'UTC', json: {}, billing_start_day: 1 }
            ];
            vi.mocked(mockEnergyRepo.getSites).mockResolvedValue(allSites);

            const token = signSiteToken(['site1'], ['user']);
            siteService = new SiteService({
                energyRepo: mockEnergyRepo,
                siteAuthToken: token
            });

            const authorizedSites = await siteService.getAuthorizedSites();
            expect(authorizedSites).toHaveLength(1);
            expect(authorizedSites[0].id).toBe('site1');
        });
    });
});
