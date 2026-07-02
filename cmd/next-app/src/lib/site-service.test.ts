
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { SiteService } from './site-service';
import { Site } from './db';
import { FleetProduct, TeslaClient } from './tesla-client';
import { SiteRepo } from './site-repo';
import { EnergyRepo } from './energy-repo';
import { TeslaTokenRepo } from './tesla-token-repo';
import { TrmnlService } from './trmnl-service';
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

        it('should return false if JWT does not contain site and not fall back to API', async () => {
            // Mock verify to return authorized object
            vi.mocked(authJwt.verifySiteToken).mockReturnValue({ sites: ['12345'], roles: [] });

            const service = new SiteService({
                teslaClient: mockTeslaClient as unknown as TeslaClient,
                siteRepo: mockEnergyRepo as unknown as SiteRepo,
                siteAuthToken: 'valid_token'
            });

            mockTeslaClient.getProducts.mockResolvedValue([{ energy_site_id: 12345 }]);

            const isValid = await service.validateSiteAccess('999');
            expect(isValid).toBe(false);
            expect(mockTeslaClient.getProducts).not.toHaveBeenCalled();
        });

        it('should return false without throwing if no teslaClient is provided and JWT is missing/invalid', async () => {
            const service = new SiteService({
                siteRepo: mockEnergyRepo as unknown as SiteRepo
            });

            const isValid = await service.validateSiteAccess('12345');
            expect(isValid).toBe(false);
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

    // The JWT fast-path trusts claims offline; a revoked user must be blocked here
    // too, otherwise removing the refresh-time check would only delay (not prevent)
    // their lockout from these JWT-only endpoints.
    describe('revocation (isUserActive)', () => {
        it('validateSiteAccess returns false for a revoked user without hitting the API', async () => {
            mockTeslaClient.getProducts.mockClear();
            vi.mocked(authJwt.verifySiteToken).mockReturnValue({ sites: ['12345'], roles: [], sub: 'u1' });

            const service = new SiteService({
                teslaClient: mockTeslaClient as unknown as TeslaClient,
                siteRepo: mockEnergyRepo as unknown as SiteRepo,
                siteAuthToken: 'valid_token',
                isUserActive: vi.fn().mockResolvedValue(false),
            });

            expect(await service.validateSiteAccess('12345')).toBe(false);
            expect(mockTeslaClient.getProducts).not.toHaveBeenCalled();
        });

        it('validateSiteAccess still authorizes an active user identified by sub', async () => {
            mockTeslaClient.getProducts.mockClear();
            vi.mocked(authJwt.verifySiteToken).mockReturnValue({ sites: ['12345'], roles: [], sub: 'u1' });

            const service = new SiteService({
                teslaClient: mockTeslaClient as unknown as TeslaClient,
                siteRepo: mockEnergyRepo as unknown as SiteRepo,
                siteAuthToken: 'valid_token',
                isUserActive: vi.fn().mockResolvedValue(true),
            });

            expect(await service.validateSiteAccess('12345')).toBe(true);
            expect(mockTeslaClient.getProducts).not.toHaveBeenCalled();
        });

        it('getAuthorizedSites returns no sites for a revoked user', async () => {
            mockTeslaClient.getProducts.mockClear();
            mockEnergyRepo.getSites.mockResolvedValue([mockSite, mockUnauthorizedSite]);
            vi.mocked(authJwt.verifySiteToken).mockReturnValue({ sites: ['12345'], roles: [], sub: 'u1' });

            const service = new SiteService({
                teslaClient: mockTeslaClient as unknown as TeslaClient,
                siteRepo: mockEnergyRepo as unknown as SiteRepo,
                siteAuthToken: 'valid_token',
                isUserActive: vi.fn().mockResolvedValue(false),
            });

            expect(await service.getAuthorizedSites()).toEqual([]);
            expect(mockTeslaClient.getProducts).not.toHaveBeenCalled();
        });
    });

    describe('loadSitePageData', () => {
        const mockSiteData = {
            id: '12345',
            name: 'Test Site',
            timezone: 'America/New_York',
            billing_start_day: 15,
            tariffs: []
        };

        const mockEnergyRepo = {
            hasData: vi.fn(),
            getUsageByTOU: vi.fn()
        };

        const mockTeslaTokenRepo = {
            getLockedRefreshHandler: vi.fn().mockReturnValue({
                refreshHandler: vi.fn(),
                errorHandler: vi.fn()
            })
        };

        const mockTrmnlService = {
            getInstallationBySiteId: vi.fn().mockResolvedValue({ id: 'inst-123' })
        };

        const mockImporter = {
            ensureSite: vi.fn()
        };

        beforeEach(() => {
            vi.resetAllMocks();
            // Default to authorized
            vi.mocked(authJwt.verifySiteToken).mockReturnValue({ sites: ['12345'], roles: [], sub: 'u1' });
            mockTeslaTokenRepo.getLockedRefreshHandler.mockReturnValue({
                refreshHandler: vi.fn(),
                errorHandler: vi.fn()
            });
            mockTrmnlService.getInstallationBySiteId.mockResolvedValue({ id: 'inst-123' });
        });

        it('returns unauthorized when validateSiteAccess fails', async () => {
            vi.mocked(authJwt.verifySiteToken).mockReturnValue(null); // Unauthorized

            const service = new SiteService({
                siteRepo: { getSites: vi.fn(), getSite: vi.fn() } as unknown as SiteRepo,
                siteAuthToken: 'invalid',
                isUserActive: vi.fn().mockResolvedValue(true)
            });

            const result = await service.loadSitePageData('12345');
            expect(result.status).toBe('unauthorized');
        });

        it('returns not-found when site does not exist in DB and ensureSite cannot create it', async () => {
            const mockSiteRepo = {
                getSites: vi.fn(),
                getSite: vi.fn().mockResolvedValue(null) // site not found
            };

            mockImporter.ensureSite.mockResolvedValue(null);

            const service = new SiteService({
                siteRepo: mockSiteRepo as unknown as SiteRepo,
                siteAuthToken: 'valid_token',
                isUserActive: vi.fn().mockResolvedValue(true),
                energyRepo: mockEnergyRepo as unknown as EnergyRepo,
                teslaTokenRepo: mockTeslaTokenRepo as unknown as TeslaTokenRepo,
                trmnlService: mockTrmnlService as unknown as TrmnlService,
                teslaClientCreator: vi.fn().mockReturnValue({}),
                importerCreator: vi.fn().mockReturnValue(mockImporter)
            });

            const result = await service.loadSitePageData('12345');
            expect(result.status).toBe('not-found');
            expect(mockImporter.ensureSite).toHaveBeenCalledWith('12345');
        });

        it('returns needs-setup when site exists but energy repo has no data', async () => {
            const mockSiteRepo = {
                getSites: vi.fn(),
                getSite: vi.fn().mockResolvedValue(mockSiteData)
            };

            mockEnergyRepo.hasData.mockResolvedValue(false);
            mockImporter.ensureSite.mockResolvedValue(mockSiteData);

            const service = new SiteService({
                siteRepo: mockSiteRepo as unknown as SiteRepo,
                siteAuthToken: 'valid_token',
                isUserActive: vi.fn().mockResolvedValue(true),
                energyRepo: mockEnergyRepo as unknown as EnergyRepo,
                teslaTokenRepo: mockTeslaTokenRepo as unknown as TeslaTokenRepo,
                trmnlService: mockTrmnlService as unknown as TrmnlService,
                teslaClientCreator: vi.fn().mockReturnValue({}),
                importerCreator: vi.fn().mockReturnValue(mockImporter)
            });

            const result = await service.loadSitePageData('12345');
            expect(result.status).toBe('needs-setup');
            expect(result).toEqual({ status: 'needs-setup', siteId: '12345' });
        });

        it('returns auth-failure when ensureSite throws a 401 error and DB has no data', async () => {
            const mockSiteRepo = {
                getSites: vi.fn(),
                getSite: vi.fn().mockResolvedValue(null) // missing in DB initially
            };

            mockEnergyRepo.hasData.mockResolvedValue(false);
            mockImporter.ensureSite.mockRejectedValue(new Error('Tesla API Error: 401 Unauthorized'));

            const service = new SiteService({
                siteRepo: mockSiteRepo as unknown as SiteRepo,
                siteAuthToken: 'valid_token',
                isUserActive: vi.fn().mockResolvedValue(true),
                energyRepo: mockEnergyRepo as unknown as EnergyRepo,
                teslaTokenRepo: mockTeslaTokenRepo as unknown as TeslaTokenRepo,
                trmnlService: mockTrmnlService as unknown as TrmnlService,
                teslaClientCreator: vi.fn().mockReturnValue({}),
                importerCreator: vi.fn().mockReturnValue(mockImporter)
            });

            const result = await service.loadSitePageData('12345');
            expect(result.status).toBe('auth-failure');
        });

        it('returns ready status with full calculated data when site has data', async () => {
            const mockSiteRepo = {
                getSites: vi.fn(),
                getSite: vi.fn().mockResolvedValue({
                    ...mockSiteData,
                    json: {
                        tariff_content_v2: {
                            currency: 'GBP'
                        }
                    }
                })
            };

            mockEnergyRepo.hasData.mockResolvedValue(true);
            mockEnergyRepo.getUsageByTOU.mockResolvedValue([{ some: 'usage' }]);

            const service = new SiteService({
                siteRepo: mockSiteRepo as unknown as SiteRepo,
                siteAuthToken: 'valid_token',
                isUserActive: vi.fn().mockResolvedValue(true),
                energyRepo: mockEnergyRepo as unknown as EnergyRepo,
                teslaTokenRepo: mockTeslaTokenRepo as unknown as TeslaTokenRepo,
                trmnlService: mockTrmnlService as unknown as TrmnlService,
                teslaClientCreator: vi.fn().mockReturnValue({}),
                importerCreator: vi.fn().mockReturnValue(mockImporter)
            });

            const result = await service.loadSitePageData('12345', '2026-07-02');
            expect(result.status).toBe('ready');
            if (result.status === 'ready') {
                expect(result.currencySymbol).toBe('£');
                expect(result.billingDay).toBe(15);
                expect(result.isCurrentPeriod).toBeDefined();
                expect(result.prevDateStr).toBeDefined();
                expect(result.nextDateStr).toBeDefined();
                expect(result.dateRangeLabel).toBeDefined();
                expect(result.usage).toEqual([{ some: 'usage' }]);
                expect(result.installation).toEqual({ id: 'inst-123' });
            }
        });
    });

    describe('getTeslaClientForSite', () => {
        it('returns null if site has no access token', async () => {
            const mockSiteRepo = {
                getSite: vi.fn().mockResolvedValue({ id: '123' })
            };
            const service = new SiteService({
                siteRepo: mockSiteRepo as unknown as SiteRepo
            });
            const client = await service.getTeslaClientForSite('123');
            expect(client).toBeNull();
        });

        it('instantiates and returns a TeslaClient if site has access token', async () => {
            const mockSiteRepo = {
                getSite: vi.fn().mockResolvedValue({ id: '123', access_token: 'abc', refresh_token: 'ref' })
            };
            const mockTeslaClient = {};
            const teslaClientCreator = vi.fn().mockReturnValue(mockTeslaClient);

            const service = new SiteService({
                siteRepo: mockSiteRepo as unknown as SiteRepo,
                teslaClientCreator
            });

            const client = await service.getTeslaClientForSite('123');
            expect(client).toBe(mockTeslaClient);
            expect(teslaClientCreator).toHaveBeenCalled();
        });
    });

    describe('getLiveStatus', () => {
        it('returns cached live status if not expired', async () => {
            const cachedStatus = { percentage_charged: 80 };
            const mockSiteRepo = {
                getSite: vi.fn().mockResolvedValue({
                    id: '123',
                    live_status_cache: cachedStatus,
                    last_live_refresh_at: Date.now() - 5 * 60 * 1000 // 5 mins ago (TTL is 16 mins)
                })
            };

            const service = new SiteService({
                siteRepo: mockSiteRepo as unknown as SiteRepo
            });

            const status = await service.getLiveStatus('123');
            expect(status).toEqual(cachedStatus);
        });

        it('fetches status from client and updates cache on cache miss', async () => {
            const newStatus = { percentage_charged: 90 };
            const mockSiteRepo = {
                getSite: vi.fn().mockResolvedValue({
                    id: '123',
                    live_status_cache: null,
                    access_token: 'abc'
                }),
                updateLiveStatusCache: vi.fn()
            };

            const mockTeslaClient = {
                getLiveStatus: vi.fn().mockResolvedValue(newStatus)
            };

            const service = new SiteService({
                siteRepo: mockSiteRepo as unknown as SiteRepo,
                teslaClientCreator: () => mockTeslaClient as unknown as TeslaClient
            });

            const status = await service.getLiveStatus('123');
            expect(status).toEqual(newStatus);
            expect(mockSiteRepo.updateLiveStatusCache).toHaveBeenCalledWith('123', newStatus, expect.any(Number));
        });

        it('returns stale cache if client fetch fails', async () => {
            const staleStatus = { percentage_charged: 75 };
            const mockSiteRepo = {
                getSite: vi.fn().mockResolvedValue({
                    id: '123',
                    live_status_cache: staleStatus,
                    last_live_refresh_at: Date.now() - 30 * 60 * 1000, // 30 mins ago (expired)
                    access_token: 'abc'
                })
            };

            const mockTeslaClient = {
                getLiveStatus: vi.fn().mockRejectedValue(new Error('Tesla API Offline'))
            };

            const service = new SiteService({
                siteRepo: mockSiteRepo as unknown as SiteRepo,
                teslaClientCreator: () => mockTeslaClient as unknown as TeslaClient
            });

            const status = await service.getLiveStatus('123');
            expect(status).toEqual(staleStatus);
        });
    });

    describe('refreshLiveStatus', () => {
        it('forces a foreground live status fetch and updates cache', async () => {
            const newStatus = { percentage_charged: 95 };
            const mockSiteRepo = {
                getSite: vi.fn().mockResolvedValue({ id: '123', access_token: 'abc' }),
                updateLiveStatusCache: vi.fn()
            };

            const mockTeslaClient = {
                getLiveStatus: vi.fn().mockResolvedValue(newStatus)
            };

            const service = new SiteService({
                siteRepo: mockSiteRepo as unknown as SiteRepo,
                teslaClientCreator: () => mockTeslaClient as unknown as TeslaClient
            });

            const status = await service.refreshLiveStatus('123');
            expect(status).toEqual(newStatus);
            expect(mockSiteRepo.updateLiveStatusCache).toHaveBeenCalledWith('123', newStatus, expect.any(Number));
        });
    });
});

