import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TeslaAuthService, TeslaCallbackParams } from './tesla-auth-service';
import { UserRepo } from './user-repo';
import { SiteRepo } from './site-repo';
import { TeslaTokenRepo } from './tesla-token-repo';

describe('TeslaAuthService', () => {
    const mockUserRepo = {
        upsertOnTeslaAuth: vi.fn(),
        getById: vi.fn()
    };

    const mockSiteRepo = {
        assignSiteToUser: vi.fn()
    };

    const mockTeslaTokenRepo = {
        updateSiteTokens: vi.fn(),
        releaseRefreshLock: vi.fn()
    };

    const mockTeslaClient = {
        getUserInfo: vi.fn(),
        getProducts: vi.fn()
    };

    const mockImporter = {
        ensureSite: vi.fn()
    };

    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('returns state-mismatch status when state does not match savedState', async () => {
        const service = new TeslaAuthService();
        const params: TeslaCallbackParams = {
            code: '123',
            state: 'mismatch',
            savedState: 'actual',
            savedNonce: 'nonce',
            callbackUrl: 'http://localhost/callback'
        };

        const result = await service.handleTeslaCallback(params);
        expect(result.status).toBe('state-mismatch');
    });

    it('returns nonce-mismatch status when nonce in ID token does not match savedNonce', async () => {
        const tokenExchange = vi.fn().mockResolvedValue({
            id_token: 'id_token_xyz',
            access_token: 'access',
            refresh_token: 'refresh',
            expires_in: 3600
        });

        const verifyIdToken = vi.fn().mockResolvedValue({
            nonce: 'another-nonce',
            sub: 'sub-123'
        });

        const service = new TeslaAuthService({
            tokenExchange,
            verifyIdToken
        });

        const params: TeslaCallbackParams = {
            code: '123',
            state: 'state',
            savedState: 'state',
            savedNonce: 'expected-nonce',
            callbackUrl: 'http://localhost/callback'
        };

        const result = await service.handleTeslaCallback(params);
        expect(result.status).toBe('nonce-mismatch');
    });

    it('processes successful OAuth flow and imports authorized sites', async () => {
        const tokenExchange = vi.fn().mockResolvedValue({
            id_token: 'valid_id_token',
            access_token: 'access_123',
            refresh_token: 'refresh_123',
            expires_in: 3600
        });

        const verifyIdToken = vi.fn().mockResolvedValue({
            nonce: 'good-nonce',
            sub: 'tesla-user-sub',
            email: 'user@example.com'
        });

        mockTeslaClient.getUserInfo.mockResolvedValue({ email: 'user@example.com' });
        mockTeslaClient.getProducts.mockResolvedValue([
            { energy_site_id: 98765, resource_type: 'battery', site_name: 'Home Powerwall' }
        ]);

        mockUserRepo.getById.mockResolvedValue({ id: 'tesla-user-sub', roles: ['user'] });

        const service = new TeslaAuthService({
            userRepo: mockUserRepo as unknown as UserRepo,
            siteRepo: mockSiteRepo as unknown as SiteRepo,
            teslaTokenRepo: mockTeslaTokenRepo as unknown as TeslaTokenRepo,
            teslaClientCreator: vi.fn().mockReturnValue(mockTeslaClient),
            importerCreator: vi.fn().mockReturnValue(mockImporter),
            tokenExchange,
            verifyIdToken
        });

        const params: TeslaCallbackParams = {
            code: 'auth_code_xyz',
            state: 'valid_state',
            savedState: 'valid_state',
            savedNonce: 'good-nonce',
            callbackUrl: 'http://localhost/callback'
        };

        const result = await service.handleTeslaCallback(params);

        expect(result.status).toBe('success');
        if (result.status === 'success') {
            expect(result.userId).toBe('tesla-user-sub');
            expect(result.siteIds).toEqual(['98765']);
            expect(result.roles).toEqual(['user']);
        }

        expect(mockUserRepo.upsertOnTeslaAuth).toHaveBeenCalledWith({
            userId: 'tesla-user-sub',
            email: 'user@example.com',
            accessToken: 'access_123',
            refreshToken: 'refresh_123',
            tokenExpiresAt: expect.any(Number)
        });

        expect(mockImporter.ensureSite).toHaveBeenCalledWith('98765');
        expect(mockSiteRepo.assignSiteToUser).toHaveBeenCalledWith('98765', 'tesla-user-sub');
        expect(mockTeslaTokenRepo.updateSiteTokens).toHaveBeenCalledWith('98765', 'access_123', 'refresh_123');
        expect(mockTeslaTokenRepo.releaseRefreshLock).toHaveBeenCalledWith('98765');
    });

    it('returns success but logs error when DB update / getProducts throws an error', async () => {
        const tokenExchange = vi.fn().mockResolvedValue({
            id_token: 'valid_id_token',
            access_token: 'access_123',
            refresh_token: 'refresh_123',
            expires_in: 3600
        });

        const verifyIdToken = vi.fn().mockResolvedValue({
            nonce: 'good-nonce',
            sub: 'tesla-user-sub',
            email: 'user@example.com'
        });

        mockTeslaClient.getProducts.mockRejectedValue(new Error('Tesla Fleet API Down'));

        const service = new TeslaAuthService({
            userRepo: mockUserRepo as unknown as UserRepo,
            siteRepo: mockSiteRepo as unknown as SiteRepo,
            teslaTokenRepo: mockTeslaTokenRepo as unknown as TeslaTokenRepo,
            teslaClientCreator: vi.fn().mockReturnValue(mockTeslaClient),
            importerCreator: vi.fn().mockReturnValue(mockImporter),
            tokenExchange,
            verifyIdToken
        });

        const params: TeslaCallbackParams = {
            code: 'auth_code_xyz',
            state: 'valid_state',
            savedState: 'valid_state',
            savedNonce: 'good-nonce',
            callbackUrl: 'http://localhost/callback'
        };

        const result = await service.handleTeslaCallback(params);

        expect(result.status).toBe('success');
        if (result.status === 'success') {
            expect(result.userId).toBe('tesla-user-sub');
            expect(result.siteIds).toEqual([]);
            expect(result.roles).toEqual([]);
        }
    });

    it('excludes failed sites from final success siteIds list when importing some sites fails', async () => {
        const tokenExchange = vi.fn().mockResolvedValue({
            id_token: 'valid_id_token',
            access_token: 'access_123',
            refresh_token: 'refresh_123',
            expires_in: 3600
        });

        const verifyIdToken = vi.fn().mockResolvedValue({
            nonce: 'good-nonce',
            sub: 'tesla-user-sub',
            email: 'user@example.com'
        });

        mockTeslaClient.getUserInfo.mockResolvedValue({ email: 'user@example.com' });
        mockTeslaClient.getProducts.mockResolvedValue([
            { energy_site_id: 11111, resource_type: 'battery', site_name: 'Site A' },
            { energy_site_id: 22222, resource_type: 'battery', site_name: 'Site B' }
        ]);

        mockUserRepo.getById.mockResolvedValue({ id: 'tesla-user-sub', roles: ['user'] });

        mockImporter.ensureSite.mockImplementation(async (siteId: string) => {
            if (siteId === '22222') {
                throw new Error('Import error');
            }
            return {};
        });

        const service = new TeslaAuthService({
            userRepo: mockUserRepo as unknown as UserRepo,
            siteRepo: mockSiteRepo as unknown as SiteRepo,
            teslaTokenRepo: mockTeslaTokenRepo as unknown as TeslaTokenRepo,
            teslaClientCreator: vi.fn().mockReturnValue(mockTeslaClient),
            importerCreator: vi.fn().mockReturnValue(mockImporter),
            tokenExchange,
            verifyIdToken
        });

        const params: TeslaCallbackParams = {
            code: 'auth_code_xyz',
            state: 'valid_state',
            savedState: 'valid_state',
            savedNonce: 'good-nonce',
            callbackUrl: 'http://localhost/callback'
        };

        const result = await service.handleTeslaCallback(params);

        expect(result.status).toBe('success');
        if (result.status === 'success') {
            expect(result.siteIds).toEqual(['11111']);
        }
    });

    it('returns empty siteIds when products list is empty', async () => {
        const tokenExchange = vi.fn().mockResolvedValue({
            id_token: 'valid_id_token',
            access_token: 'access_123',
            refresh_token: 'refresh_123',
            expires_in: 3600
        });

        const verifyIdToken = vi.fn().mockResolvedValue({
            nonce: 'good-nonce',
            sub: 'tesla-user-sub',
            email: 'user@example.com'
        });

        mockTeslaClient.getUserInfo.mockResolvedValue({ email: 'user@example.com' });
        mockTeslaClient.getProducts.mockResolvedValue([]);

        mockUserRepo.getById.mockResolvedValue({ id: 'tesla-user-sub', roles: ['user'] });

        const service = new TeslaAuthService({
            userRepo: mockUserRepo as unknown as UserRepo,
            siteRepo: mockSiteRepo as unknown as SiteRepo,
            teslaTokenRepo: mockTeslaTokenRepo as unknown as TeslaTokenRepo,
            teslaClientCreator: vi.fn().mockReturnValue(mockTeslaClient),
            importerCreator: vi.fn().mockReturnValue(mockImporter),
            tokenExchange,
            verifyIdToken
        });

        const params: TeslaCallbackParams = {
            code: 'auth_code_xyz',
            state: 'valid_state',
            savedState: 'valid_state',
            savedNonce: 'good-nonce',
            callbackUrl: 'http://localhost/callback'
        };

        const result = await service.handleTeslaCallback(params);

        expect(result.status).toBe('success');
        if (result.status === 'success') {
            expect(result.siteIds).toEqual([]);
        }
    });
});
