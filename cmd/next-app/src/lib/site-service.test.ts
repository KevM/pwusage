
import { describe, it, expect, vi } from 'vitest';
import { SiteService } from './site-service';
import { Site } from './db';
import { FleetProduct, TeslaClient } from './tesla-client';
import { SiteRepo } from './site-repo';
import * as authJwt from './auth-jwt';

// Mock auth-jwt to verify it's being called
vi.mock('./auth-jwt', () => ({
    signSiteToken: vi.fn(),
    verifySiteToken: vi.fn(),
}));

describe('SiteService Security', () => {

    // Mock Data
    const mockSite: Site = { id: '12345', name: 'Authorized Site' } as Site;
    const mockProduct: FleetProduct = { energy_site_id: 12345 } as FleetProduct;
    const mockUnauthorizedSite: Site = { id: '67890', name: 'Unauthorized Site' } as Site;

    const mockTeslaClient = {
        getProducts: vi.fn()
    };

    const mockEnergyRepo = {
        getSites: vi.fn()
    };

    it('should filter sites based on API authorization when no JWT provided', async () => {
        mockTeslaClient.getProducts.mockResolvedValue([mockProduct]);
        mockEnergyRepo.getSites.mockResolvedValue([mockSite, mockUnauthorizedSite]);

        const service = new SiteService({
            teslaClient: mockTeslaClient as unknown as TeslaClient,
            siteRepo: mockEnergyRepo as unknown as SiteRepo
        });

        const sites = await service.getAuthorizedSites();

        expect(sites).toHaveLength(1);
        expect(sites[0].id).toBe(mockSite.id);
        expect(mockTeslaClient.getProducts).toHaveBeenCalled();
    });

    it('should use JWT for authorization if provided and valid', async () => {
        mockTeslaClient.getProducts.mockClear();
        mockEnergyRepo.getSites.mockResolvedValue([mockSite, mockUnauthorizedSite]);

        // Mock verify to return authorized object
        vi.mocked(authJwt.verifySiteToken).mockReturnValue({ sites: ['12345'], roles: [] });

        const service = new SiteService({
            teslaClient: mockTeslaClient as unknown as TeslaClient,
            siteRepo: mockEnergyRepo as unknown as SiteRepo,
            siteAuthToken: 'valid_token'
        });

        const sites = await service.getAuthorizedSites();

        expect(sites).toHaveLength(1);
        expect(sites[0].id).toBe('12345');
        // Should NOT call API
        expect(mockTeslaClient.getProducts).not.toHaveBeenCalled();
    });

    it('should fall back to API if JWT is invalid', async () => {
        mockTeslaClient.getProducts.mockClear();
        mockTeslaClient.getProducts.mockResolvedValue([mockProduct]);
        mockEnergyRepo.getSites.mockResolvedValue([mockSite]);

        // Mock verify to return null
        vi.mocked(authJwt.verifySiteToken).mockReturnValue(null);

        const service = new SiteService({
            teslaClient: mockTeslaClient as unknown as TeslaClient,
            siteRepo: mockEnergyRepo as unknown as SiteRepo,
            siteAuthToken: 'invalid_token'
        });

        const sites = await service.getAuthorizedSites();

        expect(sites).toHaveLength(1);
        expect(sites[0].id).toBe('12345');
        // Should call API
        expect(mockTeslaClient.getProducts).toHaveBeenCalled();
    });

    describe('validateSiteAccess', () => {
        it('should return true if JWT validates site', async () => {
            mockTeslaClient.getProducts.mockClear();
            vi.mocked(authJwt.verifySiteToken).mockReturnValue({ sites: ['12345'], roles: [] });

            const service = new SiteService({
                teslaClient: mockTeslaClient as unknown as TeslaClient,
                siteRepo: mockEnergyRepo as unknown as SiteRepo,
                siteAuthToken: 'valid_token'
            });

            const isValid = await service.validateSiteAccess('12345');
            expect(isValid).toBe(true);
            expect(mockTeslaClient.getProducts).not.toHaveBeenCalled();
        });

        it('should return false if JWT does not contain site', async () => {
            // Mock verify to return authorized object
            vi.mocked(authJwt.verifySiteToken).mockReturnValue({ sites: ['12345'], roles: [] });

            const service = new SiteService({
                teslaClient: mockTeslaClient as unknown as TeslaClient,
                siteRepo: mockEnergyRepo as unknown as SiteRepo,
                siteAuthToken: 'valid_token'
            });

            // Note: validateSiteAccess falls back to API if JWT fails to validate?
            // "1. Fast, offline check... if (sites && sites.includes(siteId)) return true;"
            // It falls through to "2. Fallback to API".
            // So if JWT says No, it double checks with API.
            mockTeslaClient.getProducts.mockResolvedValue([{ energy_site_id: 12345 }]); // API also says No to 999

            const isValid = await service.validateSiteAccess('999');
            expect(isValid).toBe(false);
            expect(mockTeslaClient.getProducts).toHaveBeenCalled();
        });

        it('should return true via API if JWT missing', async () => {
            mockTeslaClient.getProducts.mockResolvedValue([{ energy_site_id: 12345 }]);

            const service = new SiteService({
                teslaClient: mockTeslaClient as unknown as TeslaClient,
                siteRepo: mockEnergyRepo as unknown as SiteRepo
            });

            const isValid = await service.validateSiteAccess('12345');
            expect(isValid).toBe(true);
            expect(mockTeslaClient.getProducts).toHaveBeenCalled();
        });
    });
});
