import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JwtPayload } from 'jsonwebtoken';
import { TeslaAuthService, TeslaCallbackParams } from './tesla-auth-service';

// Mocked so verifyTeslaIdToken tests can simulate a kid missing from the JWKS
// without network access; implementation is set inside each test.
vi.mock('jwks-rsa');
import { UserRepo } from './user-repo';
import { SiteRepo } from './site-repo';
import { TeslaTokenRepo } from './tesla-token-repo';

describe('TeslaAuthService', () => {
    const mockUserRepo = {
        upsertOnTeslaAuth: vi.fn(),
        getById: vi.fn(),
        getByEmail: vi.fn()
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
        process.env.PUBLIC_TESLA_OAUTH_CLIENT_ID = 'client-id-123';
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

    it('(a) unknown-kid -> userInfo ok (realistic TeslaUserInfo shape) -> authenticated (success)', async () => {
        const { KidNotFoundError } = await import('./tesla-auth-service');
        const tokenExchange = vi.fn().mockResolvedValue({
            id_token: 'id_token_unpublished_kid',
            access_token: 'access_123',
            refresh_token: 'refresh_123',
            expires_in: 3600
        });

        const verifyIdToken = vi.fn().mockRejectedValue(new KidNotFoundError('HgAhP6'));

        // Realistic TeslaUserInfo returned by Tesla /api/1/users/me endpoint
        mockTeslaClient.getUserInfo.mockResolvedValue({
            email: 'user@example.com',
            full_name: 'John Doe',
            profile_image_url: 'https://example.com/photo.jpg',
            vault_uuid: 'user-sub-123'
        });
        mockTeslaClient.getProducts.mockResolvedValue([]);
        mockUserRepo.getById.mockResolvedValue({ id: 'user-sub-123', roles: ['user'] });

        const service = new TeslaAuthService({
            userRepo: mockUserRepo as unknown as UserRepo,
            siteRepo: mockSiteRepo as unknown as SiteRepo,
            teslaTokenRepo: mockTeslaTokenRepo as unknown as TeslaTokenRepo,
            teslaClientCreator: vi.fn().mockReturnValue(mockTeslaClient),
            importerCreator: vi.fn().mockReturnValue(mockImporter),
            tokenExchange,
            verifyIdToken
        });

        const jwt = await import('jsonwebtoken');
        vi.spyOn(jwt.default, 'decode').mockReturnValue({
            iss: 'https://auth.tesla.com/oauth2/v3',
            aud: process.env.PUBLIC_TESLA_OAUTH_CLIENT_ID || 'client-id-123',
            exp: Math.floor(Date.now() / 1000) + 3600,
            nonce: 'good-nonce',
            sub: 'user-sub-123',
            email: 'user@example.com'
        } as unknown as JwtPayload);

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
            expect(result.userId).toBe('user-sub-123');
        }
    });

    it('(a2) unknown-kid -> userInfo without sub/vault_uuid -> uses authenticated email identity (P2 guard)', async () => {
        const { KidNotFoundError } = await import('./tesla-auth-service');
        const tokenExchange = vi.fn().mockResolvedValue({
            id_token: 'id_token_unconfirmed_sub',
            access_token: 'access_123',
            refresh_token: 'refresh_123',
            expires_in: 3600
        });

        const verifyIdToken = vi.fn().mockRejectedValue(new KidNotFoundError('HgAhP6'));

        // userInfo returns email only (no sub or vault_uuid)
        mockTeslaClient.getUserInfo.mockResolvedValue({
            email: 'user@example.com'
        });
        mockTeslaClient.getProducts.mockResolvedValue([]);
        mockUserRepo.getById.mockResolvedValue({ id: 'user@example.com', roles: ['user'] });

        const service = new TeslaAuthService({
            userRepo: mockUserRepo as unknown as UserRepo,
            siteRepo: mockSiteRepo as unknown as SiteRepo,
            teslaTokenRepo: mockTeslaTokenRepo as unknown as TeslaTokenRepo,
            teslaClientCreator: vi.fn().mockReturnValue(mockTeslaClient),
            importerCreator: vi.fn().mockReturnValue(mockImporter),
            tokenExchange,
            verifyIdToken
        });

        const jwt = await import('jsonwebtoken');
        vi.spyOn(jwt.default, 'decode').mockReturnValue({
            iss: 'https://auth.tesla.com/oauth2/v3',
            aud: process.env.PUBLIC_TESLA_OAUTH_CLIENT_ID || 'client-id-123',
            exp: Math.floor(Date.now() / 1000) + 3600,
            nonce: 'good-nonce',
            sub: 'unconfirmed-attacker-sub',
            email: 'user@example.com'
        } as unknown as JwtPayload);

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
            // Must use authenticated email, NEVER unconfirmed decoded.sub
            expect(result.userId).toBe('user@example.com');
        }
    });

    it('(a3) unknown-kid -> unconfirmed sub -> reconciles to existing user account ID by email (prevents account split)', async () => {
        const { KidNotFoundError } = await import('./tesla-auth-service');
        const tokenExchange = vi.fn().mockResolvedValue({
            id_token: 'id_token_unconfirmed_sub',
            access_token: 'access_123',
            refresh_token: 'refresh_123',
            expires_in: 3600
        });

        const verifyIdToken = vi.fn().mockRejectedValue(new KidNotFoundError('HgAhP6'));

        mockTeslaClient.getUserInfo.mockResolvedValue({
            email: 'user@example.com'
        });
        mockTeslaClient.getProducts.mockResolvedValue([]);
        // Mock existing user account with original UUID sub id
        mockUserRepo.getByEmail = vi.fn().mockResolvedValue({ id: 'original-sub-uuid-123', email: 'user@example.com', roles: ['user'] });
        mockUserRepo.getById.mockResolvedValue({ id: 'original-sub-uuid-123', roles: ['user'] });

        const service = new TeslaAuthService({
            userRepo: mockUserRepo as unknown as UserRepo,
            siteRepo: mockSiteRepo as unknown as SiteRepo,
            teslaTokenRepo: mockTeslaTokenRepo as unknown as TeslaTokenRepo,
            teslaClientCreator: vi.fn().mockReturnValue(mockTeslaClient),
            importerCreator: vi.fn().mockReturnValue(mockImporter),
            tokenExchange,
            verifyIdToken
        });

        const jwt = await import('jsonwebtoken');
        vi.spyOn(jwt.default, 'decode').mockReturnValue({
            iss: 'https://auth.tesla.com/oauth2/v3',
            aud: process.env.PUBLIC_TESLA_OAUTH_CLIENT_ID || 'client-id-123',
            exp: Math.floor(Date.now() / 1000) + 3600,
            nonce: 'good-nonce',
            sub: 'unconfirmed-sub',
            email: 'user@example.com'
        } as unknown as JwtPayload);

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
            // Reconciles to original user account ID instead of creating a duplicate email-keyed row
            expect(result.userId).toBe('original-sub-uuid-123');
        }
    });

    it('(b) unknown-kid -> userInfo fails -> rejected (invalid-id-token)', async () => {
        const { KidNotFoundError } = await import('./tesla-auth-service');
        const tokenExchange = vi.fn().mockResolvedValue({
            id_token: 'invalid_id_token',
            access_token: 'access_123',
            refresh_token: 'refresh_123',
            expires_in: 3600
        });

        const verifyIdToken = vi.fn().mockRejectedValue(new KidNotFoundError('HgAhP6'));
        mockTeslaClient.getUserInfo.mockRejectedValue(new Error('401 Unauthorized'));

        const service = new TeslaAuthService({
            teslaClientCreator: vi.fn().mockReturnValue(mockTeslaClient),
            tokenExchange,
            verifyIdToken
        });

        const jwt = await import('jsonwebtoken');
        vi.spyOn(jwt.default, 'decode').mockReturnValue({
            iss: 'https://auth.tesla.com/oauth2/v3',
            aud: process.env.PUBLIC_TESLA_OAUTH_CLIENT_ID || 'client-id-123',
            exp: Math.floor(Date.now() / 1000) + 3600,
            nonce: 'good-nonce',
            sub: 'user-sub-123'
        } as unknown as JwtPayload);

        const params: TeslaCallbackParams = {
            code: 'auth_code_xyz',
            state: 'valid_state',
            savedState: 'valid_state',
            savedNonce: 'good-nonce',
            callbackUrl: 'http://localhost/callback'
        };

        const result = await service.handleTeslaCallback(params);
        expect(result.status).toBe('invalid-id-token');
    });

    it('(c) known kid + bad signature -> rejected (invalid-id-token regression guard)', async () => {
        const tokenExchange = vi.fn().mockResolvedValue({
            id_token: 'forged_token',
            access_token: 'access_123',
            refresh_token: 'refresh_123',
            expires_in: 3600
        });

        const jwt = await import('jsonwebtoken');
        const verifyIdToken = vi.fn().mockRejectedValue(new jwt.default.JsonWebTokenError('invalid signature'));

        mockTeslaClient.getUserInfo.mockResolvedValue({ email: 'attacker@example.com', sub: 'attacker-sub' });

        const service = new TeslaAuthService({
            teslaClientCreator: vi.fn().mockReturnValue(mockTeslaClient),
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
        expect(result.status).toBe('invalid-id-token');
    });

    it('(d) expired token in fallback -> rejected (invalid-id-token)', async () => {
        const { KidNotFoundError } = await import('./tesla-auth-service');
        const tokenExchange = vi.fn().mockResolvedValue({
            id_token: 'expired_token',
            access_token: 'access_123',
            refresh_token: 'refresh_123',
            expires_in: 3600
        });

        const verifyIdToken = vi.fn().mockRejectedValue(new KidNotFoundError('HgAhP6'));
        mockTeslaClient.getUserInfo.mockResolvedValue({ email: 'user@example.com', sub: 'user-sub-123' });

        const service = new TeslaAuthService({
            teslaClientCreator: vi.fn().mockReturnValue(mockTeslaClient),
            tokenExchange,
            verifyIdToken
        });

        const jwt = await import('jsonwebtoken');
        vi.spyOn(jwt.default, 'decode').mockReturnValue({
            iss: 'https://auth.tesla.com/oauth2/v3',
            aud: process.env.PUBLIC_TESLA_OAUTH_CLIENT_ID || 'client-id-123',
            exp: Math.floor(Date.now() / 1000) - 3600,
            nonce: 'good-nonce',
            sub: 'user-sub-123'
        } as unknown as JwtPayload);

        const params: TeslaCallbackParams = {
            code: 'auth_code_xyz',
            state: 'valid_state',
            savedState: 'valid_state',
            savedNonce: 'good-nonce',
            callbackUrl: 'http://localhost/callback'
        };

        const result = await service.handleTeslaCallback(params);
        expect(result.status).toBe('invalid-id-token');
    });

    it('(e) wrong aud in fallback -> rejected (invalid-id-token)', async () => {
        const { KidNotFoundError } = await import('./tesla-auth-service');
        const tokenExchange = vi.fn().mockResolvedValue({
            id_token: 'wrong_aud_token',
            access_token: 'access_123',
            refresh_token: 'refresh_123',
            expires_in: 3600
        });

        const verifyIdToken = vi.fn().mockRejectedValue(new KidNotFoundError('HgAhP6'));
        mockTeslaClient.getUserInfo.mockResolvedValue({ email: 'user@example.com', sub: 'user-sub-123' });

        const service = new TeslaAuthService({
            teslaClientCreator: vi.fn().mockReturnValue(mockTeslaClient),
            tokenExchange,
            verifyIdToken
        });

        const jwt = await import('jsonwebtoken');
        vi.spyOn(jwt.default, 'decode').mockReturnValue({
            iss: 'https://auth.tesla.com/oauth2/v3',
            aud: 'wrong-client-id',
            exp: Math.floor(Date.now() / 1000) + 3600,
            nonce: 'good-nonce',
            sub: 'user-sub-123'
        } as unknown as JwtPayload);

        const params: TeslaCallbackParams = {
            code: 'auth_code_xyz',
            state: 'valid_state',
            savedState: 'valid_state',
            savedNonce: 'good-nonce',
            callbackUrl: 'http://localhost/callback'
        };

        const result = await service.handleTeslaCallback(params);
        expect(result.status).toBe('invalid-id-token');
    });

    it('(f) nonce mismatch -> rejected (nonce-mismatch)', async () => {
        const { KidNotFoundError } = await import('./tesla-auth-service');
        const tokenExchange = vi.fn().mockResolvedValue({
            id_token: 'token_bad_nonce',
            access_token: 'access_123',
            refresh_token: 'refresh_123',
            expires_in: 3600
        });

        const verifyIdToken = vi.fn().mockRejectedValue(new KidNotFoundError('HgAhP6'));

        const service = new TeslaAuthService({
            tokenExchange,
            verifyIdToken
        });

        const jwt = await import('jsonwebtoken');
        vi.spyOn(jwt.default, 'decode').mockReturnValue({
            iss: 'https://auth.tesla.com/oauth2/v3',
            aud: process.env.PUBLIC_TESLA_OAUTH_CLIENT_ID || 'client-id-123',
            exp: Math.floor(Date.now() / 1000) + 3600,
            nonce: 'wrong-nonce',
            sub: 'user-sub-123'
        } as unknown as JwtPayload);

        const params: TeslaCallbackParams = {
            code: 'auth_code_xyz',
            state: 'valid_state',
            savedState: 'valid_state',
            savedNonce: 'good-nonce',
            callbackUrl: 'http://localhost/callback'
        };

        const result = await service.handleTeslaCallback(params);
        expect(result.status).toBe('nonce-mismatch');
    });

    it('(g1) email mismatch between token and userInfo -> rejected (invalid-id-token)', async () => {
        const { KidNotFoundError } = await import('./tesla-auth-service');
        const tokenExchange = vi.fn().mockResolvedValue({
            id_token: 'token_email_mismatch',
            access_token: 'access_123',
            refresh_token: 'refresh_123',
            expires_in: 3600
        });

        const verifyIdToken = vi.fn().mockRejectedValue(new KidNotFoundError('HgAhP6'));
        mockTeslaClient.getUserInfo.mockResolvedValue({ email: 'realuser@example.com', vault_uuid: 'sub-123' });

        const service = new TeslaAuthService({
            teslaClientCreator: vi.fn().mockReturnValue(mockTeslaClient),
            tokenExchange,
            verifyIdToken
        });

        const jwt = await import('jsonwebtoken');
        vi.spyOn(jwt.default, 'decode').mockReturnValue({
            iss: 'https://auth.tesla.com/oauth2/v3',
            aud: process.env.PUBLIC_TESLA_OAUTH_CLIENT_ID || 'client-id-123',
            exp: Math.floor(Date.now() / 1000) + 3600,
            nonce: 'good-nonce',
            email: 'attacker@example.com', // Mismatch!
            sub: 'sub-123'
        } as unknown as JwtPayload);

        const params: TeslaCallbackParams = {
            code: 'auth_code_xyz',
            state: 'valid_state',
            savedState: 'valid_state',
            savedNonce: 'good-nonce',
            callbackUrl: 'http://localhost/callback'
        };

        const result = await service.handleTeslaCallback(params);
        expect(result.status).toBe('invalid-id-token');
    });

    it('(g2) vault_uuid difference logs warning without false-positive lockout when email matches', async () => {
        const { KidNotFoundError } = await import('./tesla-auth-service');
        const tokenExchange = vi.fn().mockResolvedValue({
            id_token: 'token_sub_mismatch',
            access_token: 'access_123',
            refresh_token: 'refresh_123',
            expires_in: 3600
        });

        const verifyIdToken = vi.fn().mockRejectedValue(new KidNotFoundError('HgAhP6'));
        // Tesla /users/me endpoint returns vault_uuid which may differ from OIDC sub
        mockTeslaClient.getUserInfo.mockResolvedValue({
            email: 'user@example.com',
            vault_uuid: 'vault-uuid-different-namespace'
        });
        mockTeslaClient.getProducts.mockResolvedValue([]);
        mockUserRepo.getById.mockResolvedValue({ id: 'token-sub-123', roles: ['user'] });

        const service = new TeslaAuthService({
            userRepo: mockUserRepo as unknown as UserRepo,
            siteRepo: mockSiteRepo as unknown as SiteRepo,
            teslaTokenRepo: mockTeslaTokenRepo as unknown as TeslaTokenRepo,
            teslaClientCreator: vi.fn().mockReturnValue(mockTeslaClient),
            importerCreator: vi.fn().mockReturnValue(mockImporter),
            tokenExchange,
            verifyIdToken
        });

        const jwt = await import('jsonwebtoken');
        vi.spyOn(jwt.default, 'decode').mockReturnValue({
            iss: 'https://auth.tesla.com/oauth2/v3',
            aud: process.env.PUBLIC_TESLA_OAUTH_CLIENT_ID || 'client-id-123',
            exp: Math.floor(Date.now() / 1000) + 3600,
            nonce: 'good-nonce',
            email: 'user@example.com',
            sub: 'token-sub-123'
        } as unknown as JwtPayload);

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
            // Unconfirmed decoded.sub falls back to authenticated email identity
            expect(result.userId).toBe('user@example.com');
        }
    });

    it('(g3) explicit sub/id mismatch between token and userInfo -> rejected (invalid-id-token)', async () => {
        const { KidNotFoundError } = await import('./tesla-auth-service');
        const tokenExchange = vi.fn().mockResolvedValue({
            id_token: 'token_explicit_sub_mismatch',
            access_token: 'access_123',
            refresh_token: 'refresh_123',
            expires_in: 3600
        });

        const verifyIdToken = vi.fn().mockRejectedValue(new KidNotFoundError('HgAhP6'));
        mockTeslaClient.getUserInfo.mockResolvedValue({ email: 'user@example.com', sub: 'actual-sub-456' });

        const service = new TeslaAuthService({
            teslaClientCreator: vi.fn().mockReturnValue(mockTeslaClient),
            tokenExchange,
            verifyIdToken
        });

        const jwt = await import('jsonwebtoken');
        vi.spyOn(jwt.default, 'decode').mockReturnValue({
            iss: 'https://auth.tesla.com/oauth2/v3',
            aud: process.env.PUBLIC_TESLA_OAUTH_CLIENT_ID || 'client-id-123',
            exp: Math.floor(Date.now() / 1000) + 3600,
            nonce: 'good-nonce',
            email: 'user@example.com',
            sub: 'different-token-sub-789'
        } as unknown as JwtPayload);

        const params: TeslaCallbackParams = {
            code: 'auth_code_xyz',
            state: 'valid_state',
            savedState: 'valid_state',
            savedNonce: 'good-nonce',
            callbackUrl: 'http://localhost/callback'
        };

        const result = await service.handleTeslaCallback(params);
        expect(result.status).toBe('invalid-id-token');
    });

    it('JWKS network fetch errors fail closed (invalid-id-token) without triggering degraded path', async () => {
        const tokenExchange = vi.fn().mockResolvedValue({
            id_token: 'some_token',
            access_token: 'access_123',
            refresh_token: 'refresh_123',
            expires_in: 3600
        });

        // Network error (NOT KidNotFoundError)
        const verifyIdToken = vi.fn().mockRejectedValue(new Error('Fetch failed: 503 Service Unavailable'));

        const service = new TeslaAuthService({
            teslaClientCreator: vi.fn().mockReturnValue(mockTeslaClient),
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
        expect(result.status).toBe('invalid-id-token');
    });

    it('reconciles a verified sub to the existing account that owns the same email', async () => {
        const tokenExchange = vi.fn().mockResolvedValue({
            id_token: 'valid_id_token',
            access_token: 'access_123',
            refresh_token: 'refresh_123',
            expires_in: 3600
        });
        const verifyIdToken = vi.fn().mockResolvedValue({
            nonce: 'good-nonce',
            sub: 'brand-new-sub',
            email: 'user@example.com'
        });

        mockTeslaClient.getUserInfo.mockResolvedValue({ email: 'user@example.com' });
        mockTeslaClient.getProducts.mockResolvedValue([
            { energy_site_id: 98765, resource_type: 'battery', site_name: 'Home Powerwall' }
        ]);
        // A legacy account keyed by the email already owns this address.
        mockUserRepo.getByEmail.mockResolvedValue({ id: 'user@example.com' });
        mockUserRepo.getById.mockResolvedValue({ id: 'user@example.com', roles: [] });

        const service = new TeslaAuthService({
            userRepo: mockUserRepo as unknown as UserRepo,
            siteRepo: mockSiteRepo as unknown as SiteRepo,
            teslaTokenRepo: mockTeslaTokenRepo as unknown as TeslaTokenRepo,
            teslaClientCreator: vi.fn().mockReturnValue(mockTeslaClient),
            importerCreator: vi.fn().mockReturnValue(mockImporter),
            tokenExchange,
            verifyIdToken
        });

        const result = await service.handleTeslaCallback({
            code: 'auth_code_xyz',
            state: 'valid_state',
            savedState: 'valid_state',
            savedNonce: 'good-nonce',
            callbackUrl: 'http://localhost/callback'
        });

        expect(result.status).toBe('success');
        if (result.status === 'success') {
            expect(result.userId).toBe('user@example.com');
        }
        expect(mockUserRepo.upsertOnTeslaAuth).toHaveBeenCalledWith(
            expect.objectContaining({ userId: 'user@example.com' })
        );
        expect(mockSiteRepo.assignSiteToUser).toHaveBeenCalledWith('98765', 'user@example.com');
    });

    it('retries the user upsert with the existing account id when the email unique index rejects the insert', async () => {
        const tokenExchange = vi.fn().mockResolvedValue({
            id_token: 'valid_id_token',
            access_token: 'access_123',
            refresh_token: 'refresh_123',
            expires_in: 3600
        });
        const verifyIdToken = vi.fn().mockResolvedValue({
            nonce: 'good-nonce',
            sub: 'racing-sub',
            email: 'race@example.com'
        });

        mockTeslaClient.getUserInfo.mockResolvedValue({ email: 'race@example.com' });
        mockTeslaClient.getProducts.mockResolvedValue([
            { energy_site_id: 98765, resource_type: 'battery', site_name: 'Home Powerwall' }
        ]);
        // Pre-upsert lookup sees nothing (the race window)...
        mockUserRepo.getByEmail
            .mockResolvedValueOnce(null)
            // ...but by the time the insert fails, the winner's row exists.
            .mockResolvedValueOnce({ id: 'winner-sub' });
        mockUserRepo.upsertOnTeslaAuth
            .mockRejectedValueOnce(Object.assign(new Error('duplicate key value violates unique constraint "idx_user_email_lower"'), { code: '23505' }))
            .mockResolvedValueOnce(undefined);
        mockUserRepo.getById.mockResolvedValue({ id: 'winner-sub', roles: [] });

        const service = new TeslaAuthService({
            userRepo: mockUserRepo as unknown as UserRepo,
            siteRepo: mockSiteRepo as unknown as SiteRepo,
            teslaTokenRepo: mockTeslaTokenRepo as unknown as TeslaTokenRepo,
            teslaClientCreator: vi.fn().mockReturnValue(mockTeslaClient),
            importerCreator: vi.fn().mockReturnValue(mockImporter),
            tokenExchange,
            verifyIdToken
        });

        const result = await service.handleTeslaCallback({
            code: 'auth_code_xyz',
            state: 'valid_state',
            savedState: 'valid_state',
            savedNonce: 'good-nonce',
            callbackUrl: 'http://localhost/callback'
        });

        expect(result.status).toBe('success');
        if (result.status === 'success') {
            expect(result.userId).toBe('winner-sub');
        }
        expect(mockUserRepo.upsertOnTeslaAuth).toHaveBeenCalledTimes(2);
        expect(mockUserRepo.upsertOnTeslaAuth).toHaveBeenLastCalledWith(
            expect.objectContaining({ userId: 'winner-sub' })
        );
        expect(mockSiteRepo.assignSiteToUser).toHaveBeenCalledWith('98765', 'winner-sub');
    });
});



describe('getDiscoveryEndpointFromIssuer', () => {
    it('maps each Tesla issuer to its own OIDC discovery URL (the /nts issuer publishes a separate JWKS)', async () => {
        const { getDiscoveryEndpointFromIssuer } = await import('./tesla-auth-service');
        expect(getDiscoveryEndpointFromIssuer('https://auth.tesla.com/oauth2/v3/nts'))
            .toBe('https://auth.tesla.com/oauth2/v3/nts/.well-known/openid-configuration');
        expect(getDiscoveryEndpointFromIssuer('https://auth.tesla.com/oauth2/v3'))
            .toBe('https://auth.tesla.com/oauth2/v3/.well-known/openid-configuration');
        expect(getDiscoveryEndpointFromIssuer('https://untrusted.com/oauth2/v3'))
            .toBeNull();
    });
});

describe('verifyTeslaIdToken', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('rejects with KidNotFoundError (not a wrapped JsonWebTokenError) when the kid is absent from the JWKS', async () => {
        process.env.PUBLIC_TESLA_OAUTH_CLIENT_ID = 'client-id-123';

        const jwksClient = (await import('jwks-rsa')).default;
        vi.mocked(jwksClient).mockReturnValue({
            getSigningKey: (kid: string | null | undefined, cb: (err: Error | null, key?: unknown) => void) =>
                cb(new Error(`Unable to find a signing key that matches '${kid}'`))
        } as unknown as ReturnType<typeof jwksClient>);

        const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
            if (String(url).includes('openid-configuration')) {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        issuer: 'https://auth.tesla.com/oauth2/v3/nts',
                        jwks_uri: 'https://auth.tesla.com/oauth2/v3/discovery/thirdparty/keys'
                    })
                };
            }
            return {
                ok: true,
                status: 200,
                json: async () => ({ keys: [{ kid: 'someOtherKid', kty: 'RSA' }] })
            };
        });
        vi.stubGlobal('fetch', fetchMock);

        const { verifyTeslaIdToken } = await import('./tesla-auth-service');

        const b64url = (obj: object) => Buffer.from(JSON.stringify(obj)).toString('base64url');
        const token = [
            b64url({ alg: 'RS256', kid: 'HgAhP6puiUWpjHH7YQ_Fcu7YoSI', typ: 'JWT' }),
            b64url({
                iss: 'https://auth.tesla.com/oauth2/v3/nts',
                aud: 'client-id-123',
                sub: 'sub-123',
                nonce: 'nonce-123',
                exp: Math.floor(Date.now() / 1000) + 3600
            }),
            Buffer.from('not-a-real-signature').toString('base64url')
        ].join('.');

        await expect(verifyTeslaIdToken(token)).rejects.toSatisfy(
            (err: unknown) => err instanceof Error && err.name === 'KidNotFoundError'
        );

        // The /nts issuer must resolve to its own discovery document, whose
        // JWKS (discovery/thirdparty/keys) actually publishes the nts kids.
        expect(fetchMock).toHaveBeenCalledWith(
            'https://auth.tesla.com/oauth2/v3/nts/.well-known/openid-configuration',
            expect.anything()
        );
    });
});

