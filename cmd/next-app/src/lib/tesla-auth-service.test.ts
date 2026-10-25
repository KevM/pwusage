import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import { TeslaAuthService, TeslaCallbackParams } from './tesla-auth-service';

// Mocked so verifyTeslaIdToken tests can simulate a kid missing from the JWKS
// without network access; implementation is set inside each test.
vi.mock('jwks-rsa');
import { UserRepo } from './user-repo';
import { SiteRepo } from './site-repo';
import { TeslaTokenRepo } from './tesla-token-repo';
import { TeslaClient, type TeslaClientConfig } from './tesla-client';

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
        resolveRegion: vi.fn(),
        getBaseUrl: vi.fn(),
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

// A test that injects a slow `verifyIdToken` dep cannot cover the removed race:
// an injected dep takes a separate, untimed branch in `handleTeslaCallback`.
// These two tests therefore drive the real verifier and inject the slow leg at
// the fetch boundary, `verifyTeslaIdToken` being module-internal. The ID token
// is genuinely RS256-signed so a verification allowed to finish really does
// succeed, rather than failing signature checks regardless of timing.
describe('ID token verification has no outer timeout race', () => {
    // Past the removed 3s cut-off but inside DISCOVERY_TIMEOUT_MS (5s), so
    // nothing but the race itself could truncate this verification. Timers are
    // faked, so it costs no wall time and cannot flake on a loaded runner.
    const SLOW_DISCOVERY_MS = 3400;
    const NTS_ISSUER = 'https://auth.tesla.com/oauth2/v3/nts';
    // The base /v3 issuer, whose hardcoded fallback key set differs from the
    // /nts one. Using it is what makes "fell back" observable at all: for /nts
    // the fallback URI and the discovered URI are the same string.
    const V3_ISSUER = 'https://auth.tesla.com/oauth2/v3';
    const V3_FALLBACK_JWKS_URI = 'https://auth.tesla.com/oauth2/v3/discovery/keys';

    let keypair!: { privateKey: string; publicKey: string };

    // Flipped when the discovery fetch settles either way. The real-timer
    // version of this test asserted it was still false when the callback
    // returned, catching the old dangling request; with faked timers the
    // equivalent is asserted mid-flight below, before the fetch is due back.
    let discoverySettled = false;

    beforeAll(() => {
        keypair = generateKeyPairSync('rsa', {
            modulusLength: 2048,
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
            publicKeyEncoding: { type: 'spki', format: 'pem' },
        });
    });

    beforeEach(() => {
        discoverySettled = false;
    });

    afterEach(async () => {
        // Real timers first: the drain below polls with setTimeout and
        // Date.now, and under faked timers neither would ever advance.
        vi.useRealTimers();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();

        // Drain any request the callback left in flight before clearing the
        // module-level client, or it installs one after the test has ended.
        // Deliberately does not assert: if the test already failed, a throwing
        // drain would bury the real assertion under a second timeout error.
        const drainDeadline = Date.now() + 2000;
        while (!discoverySettled && Date.now() < drainDeadline) {
            await new Promise((resolve) => setTimeout(resolve, 20));
        }

        const { __resetJwksClientForTests } = await import('./tesla-auth-service');
        __resetJwksClientForTests();
    });

    async function stubJwksClient(
        getSigningKey: (
            kid: string | null | undefined,
            cb: (err: Error | null, key?: unknown) => void
        ) => void
    ): Promise<void> {
        const jwksClient = (await import('jwks-rsa')).default;
        vi.mocked(jwksClient).mockReturnValue({
            getSigningKey
        } as unknown as ReturnType<typeof jwksClient>);
    }

    function signIdToken(issuer: string, nonce: string): string {
        return jwt.sign(
            {
                iss: issuer,
                aud: 'client-id-123',
                sub: 'sub-123',
                nonce,
                exp: Math.floor(Date.now() / 1000) + 3600
            },
            keypair.privateKey,
            { algorithm: 'RS256', keyid: 'test-kid' }
        );
    }

    function makeService(idToken: string): TeslaAuthService {
        mockTeslaClient.getUserInfo.mockResolvedValue({ email: 'user@example.com' });
        mockTeslaClient.getProducts.mockResolvedValue([]);
        mockUserRepo.getByEmail.mockResolvedValue(null);
        mockUserRepo.getById.mockResolvedValue({ id: 'sub-123', roles: [] });

        // No `verifyIdToken` dep: this is the branch the race lived in.
        return new TeslaAuthService({
            userRepo: mockUserRepo as unknown as UserRepo,
            siteRepo: mockSiteRepo as unknown as SiteRepo,
            teslaTokenRepo: mockTeslaTokenRepo as unknown as TeslaTokenRepo,
            teslaClientCreator: vi.fn().mockReturnValue(mockTeslaClient),
            tokenExchange: vi.fn().mockResolvedValue({
                id_token: idToken,
                access_token: 'access_123',
                refresh_token: 'refresh_123',
                expires_in: 3600
            })
        });
    }

    function callbackParams(): TeslaCallbackParams {
        return {
            code: 'auth_code_xyz',
            state: 'valid_state',
            savedState: 'valid_state',
            savedNonce: 'good-nonce',
            callbackUrl: 'http://localhost/callback'
        };
    }

    function loggedCalls(spy: { mock: { calls: unknown[][] } }): string {
        return spy.mock.calls.map((args) => args.map((arg) => String(arg)).join(' ')).join('\n');
    }

    it('completes a verification whose discovery fetch outlives the old 3s threshold', async () => {
        await stubJwksClient((_kid, cb) => cb(null, { getPublicKey: () => keypair.publicKey }));

        vi.stubGlobal('fetch', vi.fn(async () => {
            await new Promise((resolve) => setTimeout(resolve, SLOW_DISCOVERY_MS));
            discoverySettled = true;
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    issuer: NTS_ISSUER,
                    jwks_uri: 'https://auth.tesla.com/oauth2/v3/discovery/thirdparty/keys'
                })
            };
        }));

        const service = makeService(signIdToken(NTS_ISSUER, 'good-nonce'));
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        vi.useFakeTimers();
        let settled = false;
        const pending = service.handleTeslaCallback(callbackParams()).finally(() => {
            settled = true;
        });

        // This is the assertion that pins the fix. 100ms past where the race
        // rejected, verification must still be in flight with the fetch unreturned.
        await vi.advanceTimersByTimeAsync(3100);
        expect(settled).toBe(false);
        expect(discoverySettled).toBe(false);

        await vi.advanceTimersByTimeAsync(300);
        const result = await pending;

        // Under the race this was `invalid-id-token`: the cut-off threw a plain
        // Error, which is not a KidNotFoundError, so the callback failed closed.
        expect(result.status).toBe('success');

        // The slow fetch was awaited to completion rather than abandoned.
        expect(discoverySettled).toBe(true);

        // Load-bearing: every assertion above also holds on the degraded
        // KidNotFoundError path, which bypasses signature verification and still
        // ends in 'success'. Only this line proves the signature was checked.
        expect(loggedCalls(consoleLogSpy)).toContain(
            'Authentication: signature verified + nonce validated'
        );

        // And the mislabeling the race caused is gone: a slow network can no
        // longer be reported as an invalid token via this error string.
        expect(loggedCalls(consoleErrorSpy)).not.toContain('Verification timeout');
    });

    it('still succeeds when discovery fails outright, using the issuer-aware fallback key set', async () => {
        await stubJwksClient((_kid, cb) => cb(null, { getPublicKey: () => keypair.publicKey }));

        vi.stubGlobal('fetch', vi.fn(async () => {
            discoverySettled = true;
            throw Object.assign(new Error('discovery timed out'), { name: 'TimeoutError' });
        }));

        const service = makeService(signIdToken(V3_ISSUER, 'good-nonce'));
        const result = await service.handleTeslaCallback(callbackParams());

        expect(result.status).toBe('success');

        // Assert the fallback specifically: V3_ISSUER's hardcoded URI differs
        // from the /nts one, so this only holds if discovery really failed and
        // getFallbackJwksUri supplied the key set.
        const jwksClient = (await import('jwks-rsa')).default;
        const options = vi.mocked(jwksClient).mock.calls.at(-1)![0];
        expect(options.jwksUri).toBe(V3_FALLBACK_JWKS_URI);
    });
});

// Regression: requireEnv trims PUBLIC_TESLA_OAUTH_CLIENT_ID before the exchange
// sends it, so Tesla mints the ID token with `aud` set to the trimmed value. A
// raw `process.env` read at verify time disagrees with that token the moment the
// configured value carries surrounding whitespace, and every login then fails as
// `invalid-id-token`. At base the exchange also sent the raw value, so a padded
// configuration worked and requireEnv introduced the split. The whole round trip
// is driven here - real exchange, real verification, genuinely RS256-signed
// token - because the bug is precisely a disagreement between the two halves.
describe('ID token audience is compared against the normalized client id', () => {
    const NTS_ISSUER = 'https://auth.tesla.com/oauth2/v3/nts';
    const PADDED_CLIENT_ID = ' test-client-id ';
    const TRIMMED_CLIENT_ID = 'test-client-id';

    let keypair!: { privateKey: string; publicKey: string };

    beforeAll(() => {
        keypair = generateKeyPairSync('rsa', {
            modulusLength: 2048,
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
            publicKeyEncoding: { type: 'spki', format: 'pem' },
        });
    });

    afterEach(async () => {
        vi.unstubAllGlobals();
        // getOrCreateJwksClient reuses its module-level client (and its discovery
        // cache) per issuer, so without this the stub installed here would still be
        // in place for whichever test runs next.
        const { __resetJwksClientForTests } = await import('./tesla-auth-service');
        __resetJwksClientForTests();
    });

    it('accepts an ID token whose audience is the trimmed client id when the env var is padded', async () => {
        process.env.PUBLIC_TESLA_OAUTH_CLIENT_ID = PADDED_CLIENT_ID;
        process.env.TESLA_OAUTH_SECRET = 'secret-123';
        process.env.PUBLIC_TESLA_OAUTH_AUDIENCE = 'audience-123';

        const idToken = jwt.sign(
            {
                iss: NTS_ISSUER,
                aud: TRIMMED_CLIENT_ID,
                sub: 'sub-123',
                nonce: 'good-nonce',
                exp: Math.floor(Date.now() / 1000) + 3600
            },
            keypair.privateKey,
            { algorithm: 'RS256', keyid: 'test-kid' }
        );

        // One fetch stub serving both halves of the round trip: the /token POST and
        // the OIDC discovery GET. `tokenExchange` is deliberately NOT injected -
        // handleTeslaCallback prefers it over the real helper, which would skip
        // requireEnv entirely and make the padding unobservable.
        const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
            if (String(url).includes('/token')) {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        id_token: idToken,
                        access_token: 'access_123',
                        refresh_token: 'refresh_123',
                        expires_in: 3600
                    })
                } as unknown as Response;
            }
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    issuer: NTS_ISSUER,
                    jwks_uri: 'https://auth.tesla.com/oauth2/v3/discovery/thirdparty/keys'
                })
            } as unknown as Response;
        });
        vi.stubGlobal('fetch', fetchMock);

        const jwksClient = (await import('jwks-rsa')).default;
        vi.mocked(jwksClient).mockReturnValue({
            getSigningKey: (_kid: string | null | undefined, cb: (err: Error | null, key?: unknown) => void) =>
                cb(null, { getPublicKey: () => keypair.publicKey })
        } as unknown as ReturnType<typeof jwksClient>);

        mockTeslaClient.getUserInfo.mockResolvedValue({ email: 'user@example.com' });
        mockTeslaClient.getProducts.mockResolvedValue([]);
        mockUserRepo.getByEmail.mockResolvedValue(null);
        mockUserRepo.getById.mockResolvedValue({ id: 'sub-123', roles: [] });

        const service = new TeslaAuthService({
            userRepo: mockUserRepo as unknown as UserRepo,
            siteRepo: mockSiteRepo as unknown as SiteRepo,
            teslaTokenRepo: mockTeslaTokenRepo as unknown as TeslaTokenRepo,
            teslaClientCreator: vi.fn().mockReturnValue(mockTeslaClient)
        });

        const result = await service.handleTeslaCallback({
            code: 'auth_code_xyz',
            state: 'valid_state',
            savedState: 'valid_state',
            savedNonce: 'good-nonce',
            callbackUrl: 'http://localhost/callback'
        });

        // Pre-fix this was `invalid-id-token`: the exchange sent the trimmed id, so
        // the token's aud was the trimmed value, and comparing it against the raw
        // padded env read failed for every user.
        expect(result.status).toBe('success');

        // The other half of the contract, asserted from the request the code under
        // test actually made: the id on the wire is the trimmed value, which is what
        // makes the trimmed audience the correct one to compare against. A
        // `tokenExchange` stub would have made the padded/trimmed agreement
        // untestable, since nothing would have decided the sent value.
        const tokenCall = fetchMock.mock.calls.find((call) => String(call[0]).includes('/token'));
        if (!tokenCall) {
            throw new Error('expected the code exchange to have posted to a /token endpoint');
        }
        // The stub declares only the url parameter, so the recorded call tuple is one
        // element wide even though the real POST passes an init object as well.
        const [, init] = tokenCall as unknown as [string, RequestInit];
        expect(Object.fromEntries(new URLSearchParams(String(init.body))).client_id)
            .toBe(TRIMMED_CLIENT_ID);
    });
});

// Task 6: the code exchange goes through postToTeslaTokenEndpoint, which
// prefers the documented fleet-auth host and falls back to auth.tesla.com on
// 5xx/transport failures only. These tests deliberately do NOT inject
// `tokenExchange`, because handleTeslaCallback prefers deps.tokenExchange over
// the real helper and that would bypass the code under test.
describe('authorization code exchange', () => {
    // postToTeslaTokenEndpoint reads these via requireEnv. The file's outer
    // beforeEach only sets PUBLIC_TESLA_OAUTH_CLIENT_ID, so without these the
    // helper throws a plain Error (NOT TeslaTokenEndpointError), the new catch
    // rethrows it, and these tests fail with an unhandled throw.
    // Nested describes in this file set their own env, so keep it local.
    beforeEach(() => {
        process.env.PUBLIC_TESLA_OAUTH_CLIENT_ID = 'client-id-123';
        process.env.TESLA_OAUTH_SECRET = 'secret-123';
        process.env.PUBLIC_TESLA_OAUTH_AUDIENCE = 'audience-123';
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('sends the code exchange to the documented fleet-auth host', async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: false,
            status: 400,
            json: async () => ({ error: 'invalid_auth_code' }),
        } as unknown as Response);
        vi.stubGlobal('fetch', fetchMock);

        const { TeslaAuthService } = await import('./tesla-auth-service');
        const service = new TeslaAuthService();

        await service.handleTeslaCallback({
            code: 'bad-code',
            state: 's',
            savedState: 's',
            savedNonce: 'n',
            callbackUrl: 'http://localhost/callback',
        });

        const requestedUrls = fetchMock.mock.calls.map((call) => String(call[0]));
        expect(requestedUrls).toEqual([
            'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token',
        ]);

        // The six form params are authored here, so pin them here. Asserted as a
        // parsed map rather than a substring match on the encoded body, so a
        // change in encoding order or escaping cannot break or satisfy this.
        // Exact equality also catches a dropped *and* an unexpected extra param:
        // a typo in grant_type or a missing redirect_uri would break every login
        // in production and is invisible to the URL assertions above.
        const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({
            client_id: 'client-id-123',
            client_secret: 'secret-123',
            audience: 'audience-123',
            redirect_uri: 'http://localhost/callback',
            grant_type: 'authorization_code',
            code: 'bad-code',
        });
    });

    it('never falls back to a second host for a 4xx rejection', async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: false,
            status: 401,
            json: async () => ({ error: 'unauthorized_client' }),
        } as unknown as Response);
        vi.stubGlobal('fetch', fetchMock);

        const { TeslaAuthService } = await import('./tesla-auth-service');
        const service = new TeslaAuthService();

        const result = await service.handleTeslaCallback({
            code: 'bad',
            state: 's',
            savedState: 's',
            savedNonce: 'n',
            callbackUrl: 'http://localhost/callback',
        });

        expect(result.status).toBe('token-exchange-failed');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('falls back to auth.tesla.com when the primary host returns 5xx', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce({ ok: false, status: 503 } as unknown as Response)
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    id_token: 'id_token_xyz',
                    access_token: 'access_123',
                    refresh_token: 'refresh_123',
                    expires_in: 3600,
                }),
            } as unknown as Response);
        vi.stubGlobal('fetch', fetchMock);

        // Do NOT inject `tokenExchange` here: handleTeslaCallback prefers
        // deps.tokenExchange over the real helper, which would bypass
        // postToTeslaTokenEndpoint entirely and make these URL assertions
        // vacuous. Inject only verifyIdToken, so the rest of the callback does
        // not attempt real JWKS work.
        mockTeslaClient.getUserInfo.mockResolvedValue({ email: 'user@example.com' });
        mockTeslaClient.getProducts.mockResolvedValue([
            { energy_site_id: 98765, resource_type: 'battery', site_name: 'Home Powerwall' },
        ]);
        mockUserRepo.getByEmail.mockResolvedValue(null);
        mockUserRepo.getById.mockResolvedValue({ id: 'sub-123', roles: [] });

        const { TeslaAuthService } = await import('./tesla-auth-service');
        const service = new TeslaAuthService({
            userRepo: mockUserRepo as unknown as UserRepo,
            siteRepo: mockSiteRepo as unknown as SiteRepo,
            teslaTokenRepo: mockTeslaTokenRepo as unknown as TeslaTokenRepo,
            teslaClientCreator: vi.fn().mockReturnValue(mockTeslaClient),
            verifyIdToken: vi.fn().mockResolvedValue({
                nonce: 'good-nonce',
                sub: 'sub-123',
                email: 'user@example.com',
            }),
        });

        const result = await service.handleTeslaCallback({
            code: 'code',
            state: 's',
            savedState: 's',
            savedNonce: 'good-nonce',
            callbackUrl: 'http://localhost/callback',
        });

        // Without this the fixture above (getUserInfo, getProducts, getByEmail,
        // getById, verifyIdToken) is dead weight: the URL assertions hold even
        // if the second response were rejected, the nonce mismatched, or the
        // token body were garbage. Reaching 'success' is what proves the
        // fallback's 200 response was actually consumed.
        expect(result.status).toBe('success');

        // Assert the exact ordered sequence, not just that the primary was
        // tried: this is what proves the fallback to the secondary host
        // actually occurred after a 5xx. `toBeGreaterThan(0)` on its own
        // would pass even if only one URL had been requested.
        const urls = fetchMock.mock.calls.map((call) => String(call[0]));
        expect(urls).toEqual([
            'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token',
            'https://auth.tesla.com/oauth2/v3/token',
        ]);
    });

    // Regression guard: when every host 5xxs, postToTeslaTokenEndpoint throws.
    // If handleTeslaCallback lets that escape, route.ts rethrows it on the web
    // path and the user gets a raw 500 instead of the 503 they get today.
    it('reports token-exchange-failed with the upstream status when every host 5xxs', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: false,
            status: 503,
        } as unknown as Response));

        const { TeslaAuthService } = await import('./tesla-auth-service');
        const service = new TeslaAuthService();

        const result = await service.handleTeslaCallback({
            code: 'code',
            state: 's',
            savedState: 's',
            savedNonce: 'n',
            callbackUrl: 'http://localhost/callback',
        });

        expect(result).toEqual({ status: 'token-exchange-failed', statusCode: 503 });
    });

    // The helper surfaces an unexpected 3xx (never followed - see
    // tesla-token-endpoint.ts) by throwing with that status attached. This is
    // the only way a non-4xx status reaches the service, and the only case where
    // toUpstreamStatus' clamp is observable: without it the callback would hand
    // route.ts a 302, and NextResponse.json({...}, { status: 302 }) would send
    // the browser a redirect carrying no login-failure body.
    it('reports 502 rather than echoing a 3xx upstream status', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: false,
            status: 302,
        } as unknown as Response));

        const { TeslaAuthService } = await import('./tesla-auth-service');
        const service = new TeslaAuthService();

        const result = await service.handleTeslaCallback({
            code: 'code',
            state: 's',
            savedState: 's',
            savedNonce: 'n',
            callbackUrl: 'http://localhost/callback',
        });

        expect(result).toEqual({ status: 'token-exchange-failed', statusCode: 502 });
    });

    // requireEnv throws a plain Error, which is not a TeslaTokenEndpointError,
    // so it is deliberately NOT swallowed: a missing client_secret is a
    // deployment misconfiguration and should fail loudly rather than surface as
    // a user-facing token-exchange failure. Critically, it must never reach the
    // wire - the old `process.env.TESLA_OAUTH_SECRET!` non-null assertion would
    // have posted the literal string "undefined" as the client_secret.
    it('never sends a request when the client secret is missing', async () => {
        delete process.env.TESLA_OAUTH_SECRET;
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);

        const { TeslaAuthService } = await import('./tesla-auth-service');
        const service = new TeslaAuthService();

        await expect(service.handleTeslaCallback({
            code: 'code',
            state: 's',
            savedState: 's',
            savedNonce: 'n',
            callbackUrl: 'http://localhost/callback',
        })).rejects.toThrow(/TESLA_OAUTH_SECRET/);

        expect(fetchMock).not.toHaveBeenCalled();
    });

    // A 4xx is returned, not thrown, so it must still map to a 4xx passthrough.
    it('passes a 4xx straight through without consulting the fallback host', async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: false,
            status: 400,
        } as unknown as Response);
        vi.stubGlobal('fetch', fetchMock);

        const { TeslaAuthService } = await import('./tesla-auth-service');
        const service = new TeslaAuthService();

        const result = await service.handleTeslaCallback({
            code: 'bad',
            state: 's',
            savedState: 's',
            savedNonce: 'n',
            callbackUrl: 'http://localhost/callback',
        });

        expect(result).toEqual({ status: 'token-exchange-failed', statusCode: 400 });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    // A 2xx whose body is not the documented token payload is an upstream
    // defect, not a client error. `Response.json()` is typed `any`, so before
    // the parse these tests pin, the declared shape was populated by assignment
    // alone: a 200 carrying `error` where `expires_in` should be produced
    // `tokenExpiresAt: NaN`, which pg serialises as the string "NaN" and
    // Postgres rejects for a BIGINT column — a failure swallowed by the
    // surrounding catch, which then returned success with siteIds: [] and the
    // route set no site_auth cookie. The user landed on / silently
    // unauthenticated, with no error anywhere.
    //
    // This is the refresh path's bug class, which Task 7 closed with
    // parseRefreshedTokens; this test holds the exchange twin to the same rule.
    const malformedTokenBodies: [string, Record<string, unknown>][] = [
        ['a missing access_token', { id_token: 'id_token_xyz', refresh_token: 'refresh_123', expires_in: 3600 }],
        ['a missing refresh_token', { id_token: 'id_token_xyz', access_token: 'access_123', expires_in: 3600 }],
        // Not one of the three reported modes, but the service cannot even
        // verify without it, so it belongs in the same table.
        ['a missing id_token', { access_token: 'access_123', refresh_token: 'refresh_123', expires_in: 3600 }],
        ['a missing expires_in', { id_token: 'id_token_xyz', access_token: 'access_123', refresh_token: 'refresh_123' }],
        ['a string expires_in', { id_token: 'id_token_xyz', access_token: 'access_123', refresh_token: 'refresh_123', expires_in: '3600' }],
        ['a null expires_in', { id_token: 'id_token_xyz', access_token: 'access_123', refresh_token: 'refresh_123', expires_in: null }],
        ['an empty access_token', { id_token: 'id_token_xyz', access_token: '', refresh_token: 'refresh_123', expires_in: 3600 }],
    ];

    it.each(malformedTokenBodies)('never reports success for a 200 token response carrying %s', async (_label, body) => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => body,
        } as unknown as Response));

        // Deliberately a *fully* wired happy path: verifyIdToken resolves,
        // getUserInfo returns an email, getProducts is empty. Pre-fix that made
        // handleTeslaCallback return `success` for every one of these bodies,
        // which is what makes a failure here attributable to the missing
        // validation rather than to an unstubbed dependency. getProducts empty
        // also keeps the response 'success' rather than 'invalid-id-token', so
        // the pre-fix failure is exactly the silent one being pinned.
        mockTeslaClient.getUserInfo.mockResolvedValue({ email: 'user@example.com' });
        mockTeslaClient.getProducts.mockResolvedValue([]);
        mockUserRepo.getByEmail.mockResolvedValue(null);
        mockUserRepo.getById.mockResolvedValue({ id: 'sub-123', roles: [] });

        const { TeslaAuthService } = await import('./tesla-auth-service');
        const service = new TeslaAuthService({
            userRepo: mockUserRepo as unknown as UserRepo,
            siteRepo: mockSiteRepo as unknown as SiteRepo,
            teslaTokenRepo: mockTeslaTokenRepo as unknown as TeslaTokenRepo,
            teslaClientCreator: vi.fn().mockReturnValue(mockTeslaClient),
            verifyIdToken: vi.fn().mockResolvedValue({
                nonce: 'good-nonce',
                sub: 'sub-123',
                email: 'user@example.com',
            }),
        });

        const result = await service.handleTeslaCallback({
            code: 'code',
            state: 's',
            savedState: 's',
            savedNonce: 'good-nonce',
            callbackUrl: 'http://localhost/callback',
        });

        // 502, not 200/4xx: Tesla answered 2xx with something unusable, which is
        // an upstream fault. Routing it through token-exchange-failed also keeps
        // it off the raw-500 path, since route.ts rethrows anything that escapes
        // handleTeslaCallback on the web path.
        expect(result).toEqual({ status: 'token-exchange-failed', statusCode: 502 });

        // The user-facing consequence of the reported bug: a token row written
        // from an unvalidated body is how `success` was reached with no cookie.
        expect(mockUserRepo.upsertOnTeslaAuth).not.toHaveBeenCalled();
    });

    // A 200 carrying an HTML or truncated body fails in `.json()` rather than
    // in the parse, but it is the same branch and the same bug: pre-fix the
    // SyntaxError escaped handleTeslaCallback into a raw 500 on the web path.
    it('reports token-exchange-failed when a 200 response body is not JSON at all', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => {
                throw new SyntaxError('Unexpected token < in JSON at position 0');
            },
        } as unknown as Response));

        const { TeslaAuthService } = await import('./tesla-auth-service');
        const service = new TeslaAuthService();

        const result = await service.handleTeslaCallback({
            code: 'code',
            state: 's',
            savedState: 's',
            savedNonce: 'n',
            callbackUrl: 'http://localhost/callback',
        });

        expect(result).toEqual({ status: 'token-exchange-failed', statusCode: 502 });
    });
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

describe('getFallbackJwksUri', () => {
    it('maps the /nts issuer to the third-party key set that actually publishes its kids', async () => {
        const { getFallbackJwksUri } = await import('./tesla-auth-service');
        expect(getFallbackJwksUri('https://auth.tesla.com/oauth2/v3/nts'))
            .toBe('https://auth.tesla.com/oauth2/v3/discovery/thirdparty/keys');
    });

    it('maps the base /v3 issuer to its own key set', async () => {
        const { getFallbackJwksUri } = await import('./tesla-auth-service');
        expect(getFallbackJwksUri('https://auth.tesla.com/oauth2/v3'))
            .toBe('https://auth.tesla.com/oauth2/v3/discovery/keys');
    });

    it('defaults an unknown or missing issuer to the third-party set, since Tesla issues /nts tokens', async () => {
        const { getFallbackJwksUri } = await import('./tesla-auth-service');
        expect(getFallbackJwksUri('https://auth.tesla.com/oauth2/v9/unexpected'))
            .toBe('https://auth.tesla.com/oauth2/v3/discovery/thirdparty/keys');
        expect(getFallbackJwksUri(undefined))
            .toBe('https://auth.tesla.com/oauth2/v3/discovery/thirdparty/keys');
    });

    // Drift guard: adding an issuer to ALLOWED_TESLA_ISSUERS without a mapping
    // here would silently inherit the /nts default. This makes that visible.
    it('has an explicit mapping for every allowed Tesla issuer', async () => {
        const { ALLOWED_TESLA_ISSUERS, getFallbackJwksUri } = await import('./tesla-auth-service');
        // Each allowed issuer must resolve to its own key set. An issuer with no
        // explicit mapping falls back to the /nts URI and would collide with it.
        // (Comparing against getFallbackJwksUri(undefined) does not work: /nts is
        // itself the default, so that assertion can never hold.)
        const uris = ALLOWED_TESLA_ISSUERS.map((issuer) => getFallbackJwksUri(issuer));
        expect(new Set(uris).size).toBe(uris.length);
    });
});

describe('getTeslaJwksUri fallback resolution', () => {
    // The call site is where the original bug lived. Testing only the pure
    // helper would still pass if a future edit bypassed it.
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('resolves the /nts key set for an /nts token when discovery fails', async () => {
        process.env.PUBLIC_TESLA_OAUTH_CLIENT_ID = 'client-id-123';
        const { getTeslaJwksUri } = await import('./tesla-auth-service');

        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));

        await expect(getTeslaJwksUri('https://auth.tesla.com/oauth2/v3/nts'))
            .resolves.toBe('https://auth.tesla.com/oauth2/v3/discovery/thirdparty/keys');
    });

    it('resolves the base key set for a base /v3 token when discovery fails', async () => {
        process.env.PUBLIC_TESLA_OAUTH_CLIENT_ID = 'client-id-123';
        const { getTeslaJwksUri } = await import('./tesla-auth-service');

        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));

        await expect(getTeslaJwksUri('https://auth.tesla.com/oauth2/v3'))
            .resolves.toBe('https://auth.tesla.com/oauth2/v3/discovery/keys');
    });
});

describe('verifyTeslaIdToken', () => {
    afterEach(async () => {
        vi.unstubAllGlobals();
        // getOrCreateJwksClient reuses its module-level client whenever the
        // issuer matches, so a stub installed here would otherwise become the
        // client a later test verifies against.
        const { __resetJwksClientForTests } = await import('./tesla-auth-service');
        __resetJwksClientForTests();
    });

    it('rejects with KidNotFoundError (not a wrapped JsonWebTokenError) when the kid is absent from the JWKS', async () => {
        process.env.PUBLIC_TESLA_OAUTH_CLIENT_ID = 'client-id-123';

        const jwksClient = (await import('jwks-rsa')).default;
        vi.mocked(jwksClient).mockReturnValue({
            getSigningKey: (kid: string | null | undefined, cb: (err: Error | null, key?: unknown) => void) => {
                const err = new Error(`Unable to find a signing key that matches '${kid}'`);
                err.name = 'SigningKeyNotFoundError';
                cb(err);
            }
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

describe('JWKS key lookup error mapping', () => {
    afterEach(async () => {
        vi.unstubAllGlobals();
        // This block installs a stub that always fails; without a reset it is
        // still the module-level client when a later test reuses the same
        // issuer, and that test silently verifies against this stub.
        const { __resetJwksClientForTests } = await import('./tesla-auth-service');
        __resetJwksClientForTests();
    });

    async function verifyWithJwksError(errorName: string): Promise<Error> {
        process.env.PUBLIC_TESLA_OAUTH_CLIENT_ID = 'client-id-123';
        const { __resetJwksClientForTests } = await import('./tesla-auth-service');
        __resetJwksClientForTests();

        const jwksClient = (await import('jwks-rsa')).default;
        vi.mocked(jwksClient).mockReturnValue({
            getSigningKey: (_kid: string | null | undefined, cb: (err: Error | null, key?: unknown) => void) => {
                const err = new Error(`simulated ${errorName}`);
                err.name = errorName;
                cb(err);
            }
        } as unknown as ReturnType<typeof jwksClient>);

        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => ({ keys: [{ kid: 'other', kty: 'RSA' }] })
        })));

        const { verifyTeslaIdToken } = await import('./tesla-auth-service');
        const b64url = (obj: object) => Buffer.from(JSON.stringify(obj)).toString('base64url');
        const token = [
            b64url({ alg: 'RS256', kid: 'unknown-kid', typ: 'JWT' }),
            b64url({
                iss: 'https://auth.tesla.com/oauth2/v3/nts',
                aud: 'client-id-123',
                sub: 'sub-123',
                nonce: 'nonce-123',
                exp: Math.floor(Date.now() / 1000) + 3600,
            }),
            Buffer.from('not-a-real-signature').toString('base64url'),
        ].join('.');

        try {
            await verifyTeslaIdToken(token);
            throw new Error('expected verifyTeslaIdToken to reject');
        } catch (err) {
            return err as Error;
        }
    }

    it('maps SigningKeyNotFoundError to KidNotFoundError (key genuinely absent)', async () => {
        const err = await verifyWithJwksError('SigningKeyNotFoundError');
        expect(err.name).toBe('KidNotFoundError');
    });

    it('does NOT map an unreachable-endpoint error to KidNotFoundError, so the degraded signature-bypass path cannot trigger', async () => {
        const { KidNotFoundError } = await import('./tesla-auth-service');
        const err = await verifyWithJwksError('JwksError');
        // jsonwebtoken re-wraps non-KidNotFoundError key-callback failures in a
        // plain JsonWebTokenError; verifyTeslaIdToken only re-surfaces
        // KidNotFoundError. So assert the security property rather than the
        // error's exact class: handleTeslaCallback treats KidNotFoundError (by
        // instanceof OR by name) as "signature unverifiable" and takes the
        // degraded path that bypasses signature verification. Anything else must
        // not reach that path.
        expect(err).not.toBeInstanceOf(KidNotFoundError);
        expect(err.name).not.toBe('KidNotFoundError');
        // The original cause is still recoverable from the message.
        expect(err.message).toContain('simulated JwksError');
    });

    it('does NOT map a rate-limit error to KidNotFoundError', async () => {
        const { KidNotFoundError } = await import('./tesla-auth-service');
        const err = await verifyWithJwksError('JwksRateLimitError');
        expect(err).not.toBeInstanceOf(KidNotFoundError);
        expect(err.name).not.toBe('KidNotFoundError');
        expect(err.message).toContain('simulated JwksRateLimitError');
    });
});

describe('jwks client configuration', () => {
    // These blocks live at the top level, outside `describe('TeslaAuthService')`,
    // so they do not inherit that block's beforeEach. Reset mock call history
    // explicitly or `mock.calls[0]` below may refer to an earlier test.
    beforeEach(() => {
        vi.resetAllMocks();
    });

    afterEach(async () => {
        vi.unstubAllGlobals();
        // getTeslaJwksUri memoizes discovery per issuer, so a warm entry makes it
        // return without calling fetch. The `verifyTeslaIdToken` block asserts the
        // discovery document was fetched over the wire, and that assertion fails
        // whenever this block's caching test runs first. Reset here because this is
        // the block that CREATES the cache state, not the block at risk.
        const { __resetJwksClientForTests } = await import('./tesla-auth-service');
        __resetJwksClientForTests();
    });

    it('opts into stale-key availability with observability, and sets explicit rate limit and timeout', async () => {
        const { __resetJwksClientForTests } = await import('./tesla-auth-service');
        __resetJwksClientForTests();

        const jwksClient = (await import('jwks-rsa')).default;
        vi.mocked(jwksClient).mockReturnValue({
            getSigningKey: (_kid: string | null | undefined, cb: (err: Error | null, key?: unknown) => void) =>
                cb(new Error('unused')),
        } as unknown as ReturnType<typeof jwksClient>);

        vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => ({
            ok: true,
            status: 200,
            json: async () => String(url).includes('openid-configuration')
                ? {
                    issuer: 'https://auth.tesla.com/oauth2/v3/nts',
                    jwks_uri: 'https://auth.tesla.com/oauth2/v3/discovery/thirdparty/keys',
                }
                : { keys: [] },
        })));

        const { verifyTeslaIdToken } = await import('./tesla-auth-service');
        const b64url = (obj: object) => Buffer.from(JSON.stringify(obj)).toString('base64url');
        const token = [
            b64url({ alg: 'RS256', kid: 'k', typ: 'JWT' }),
            b64url({
                iss: 'https://auth.tesla.com/oauth2/v3/nts',
                aud: 'client-id-123',
                sub: 's',
                nonce: 'n',
                exp: Math.floor(Date.now() / 1000) + 3600,
            }),
            Buffer.from('sig').toString('base64url'),
        ].join('.');
        await verifyTeslaIdToken(token).catch(() => undefined);

        // Read the options through jwks-rsa's own `Options` type rather than an
        // untyped cast: a misnamed option would not typecheck here, so this
        // guards the option names and not just the call.
        const options = vi.mocked(jwksClient).mock.calls.at(-1)![0];
        expect(options.jwksUri).toBe('https://auth.tesla.com/oauth2/v3/discovery/thirdparty/keys');
        expect(options.cache).toBe(true);
        expect(typeof options.onStaleCacheFallback).toBe('function');
        expect(options.rateLimit).toBe(true);
        expect(options.jwksRequestsPerMinute).toBe(10);

        // Asserted against literal numbers, never against the constants they
        // came from: importing JWKS_STALE_FALLBACK_MS and asserting it equals
        // itself is vacuous, and that is exactly how these three went unpinned
        // through a whole branch. Set JWKS_STALE_FALLBACK_MS to ten days and
        // this test file stayed green, because the previous assertions here were
        // `toBeGreaterThan(0)` on two of them and none at all on cacheMaxAge.
        //
        // cacheMaxAge is the one that matters most and had no assertion: the
        // library measures staleness as `cacheMaxAge + cacheMaxAgeFallback`
        // (wrappers/cache.js), so cacheMaxAge is *added to* the stale-key
        // exposure rather than merely being a freshness target. 10 + 60 = 70
        // minutes from the last successful fetch. DesignDecisions.md §5 spends a
        // paragraph on that sum ("Do not 'tune' cacheMaxAge without re-reading
        // this paragraph"); these are the numbers that paragraph is about.
        expect(options.cacheMaxAge).toBe(10 * 60 * 1000);
        expect(options.cacheMaxAgeFallback).toBe(60 * 60 * 1000);
        expect(options.timeout).toBe(5 * 1000);
    });

    it('caches discovery per issuer so steady-state logins skip the round-trip', async () => {
        const { __resetJwksClientForTests } = await import('./tesla-auth-service');
        __resetJwksClientForTests();

        const jwksClient = (await import('jwks-rsa')).default;
        vi.mocked(jwksClient).mockReturnValue({
            getSigningKey: (_kid: string | null | undefined, cb: (err: Error | null, key?: unknown) => void) =>
                cb(new Error('unused')),
        } as unknown as ReturnType<typeof jwksClient>);

        const discoveryFetch = vi.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => ({
                issuer: 'https://auth.tesla.com/oauth2/v3/nts',
                jwks_uri: 'https://auth.tesla.com/oauth2/v3/discovery/thirdparty/keys',
            }),
        }));
        vi.stubGlobal('fetch', discoveryFetch);

        const { getTeslaJwksUri } = await import('./tesla-auth-service');
        const first = await getTeslaJwksUri('https://auth.tesla.com/oauth2/v3/nts');
        const second = await getTeslaJwksUri('https://auth.tesla.com/oauth2/v3/nts');

        expect(first).toBe('https://auth.tesla.com/oauth2/v3/discovery/thirdparty/keys');
        expect(second).toBe(first);
        expect(discoveryFetch).toHaveBeenCalledTimes(1);
    });

    it('reuses the cached discovery URI when discovery later fails, instead of downgrading to the fallback key set', async () => {
        const { __resetJwksClientForTests, getTeslaJwksUri, getFallbackJwksUri } =
            await import('./tesla-auth-service');
        __resetJwksClientForTests();

        // Base /v3 issuer, not /nts. For /nts the fallback and the real
        // discovered jwks_uri are the same string, so a test on /nts would still
        // pass with the reuse branch deleted. Here they differ: discovery is
        // stubbed to resolve to the thirdparty key set while this issuer's
        // hardcoded fallback is .../discovery/keys. Returning the fallback would
        // therefore be a different key set, which is exactly the silent
        // downgrade this branch exists to prevent.
        const issuer = 'https://auth.tesla.com/oauth2/v3';
        const fallbackUri = getFallbackJwksUri(issuer);
        const discoveredUri = 'https://auth.tesla.com/oauth2/v3/discovery/thirdparty/keys';
        expect(discoveredUri).not.toBe(fallbackUri);

        let discoveryUp = true;
        vi.stubGlobal('fetch', vi.fn(async () => (
            discoveryUp
                ? { ok: true, status: 200, json: async () => ({ issuer, jwks_uri: discoveredUri }) }
                : { ok: false, status: 503 }
        )));

        // Move the clock past DISCOVERY_CACHE_TTL_MS instead of waiting it out,
        // so the warm-cache short-circuit cannot return early and skip the
        // branch under test.
        let now = 1_700_000_000_000;
        const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
        try {
            await expect(getTeslaJwksUri(issuer)).resolves.toBe(discoveredUri);

            discoveryUp = false;
            now += 61 * 60 * 1000;

            const reused = await getTeslaJwksUri(issuer);
            expect(reused).toBe(discoveredUri);
            expect(reused).not.toBe(fallbackUri);
        } finally {
            nowSpy.mockRestore();
        }
    });
});

describe('TeslaAuthService regional Fleet host', () => {
    const NA = 'https://fleet-api.prd.na.vn.cloud.tesla.com';
    const EU = 'https://fleet-api.prd.eu.vn.cloud.tesla.com';
    const outOfRegion = `{"response":null,"error":"user out of region, use base URL: ${EU}, see https://developer.tesla.com/docs/fleet-api#endpoints-and-regions","error_description":""}`;

    function respond(status: number, body: unknown): Response {
        const text = typeof body === 'string' ? body : JSON.stringify(body);
        return {
            ok: status >= 200 && status < 300,
            status,
            headers: new Headers(),
            json: async () => JSON.parse(text),
            text: async () => text,
        } as unknown as Response;
    }

    /** A Fleet API that only serves this EU account from the EU host. */
    function euAccountFleet(regionEndpoint: 'ok' | 'down') {
        return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
            const url = String(input);
            if (url.endsWith('/api/1/users/region')) {
                return regionEndpoint === 'ok'
                    ? respond(200, { response: { region: 'eu', fleet_api_base_url: EU } })
                    : respond(503, 'unavailable');
            }
            if (!url.startsWith(EU)) return respond(421, outOfRegion);
            if (url.endsWith('/api/1/users/me')) return respond(200, { response: { email: 'eu@example.com' } });
            if (url.endsWith('/api/1/products')) {
                return respond(200, { response: [{ energy_site_id: 4242, resource_type: 'battery', site_name: 'Berlin' }], count: 1 });
            }
            return respond(404, 'not found');
        });
    }

    function makeService() {
        const userRepo = {
            upsertOnTeslaAuth: vi.fn(),
            getById: vi.fn().mockResolvedValue({ id: 'eu-sub', roles: [] }),
            getByEmail: vi.fn().mockResolvedValue(null),
        };
        const siteRepo = { assignSiteToUser: vi.fn() };
        const teslaTokenRepo = { updateSiteTokens: vi.fn(), releaseRefreshLock: vi.fn() };
        const importerClients: TeslaClient[] = [];
        const importer = { ensureSite: vi.fn() };
        const service = new TeslaAuthService({
            userRepo: userRepo as unknown as UserRepo,
            siteRepo: siteRepo as unknown as SiteRepo,
            teslaTokenRepo: teslaTokenRepo as unknown as TeslaTokenRepo,
            teslaClientCreator: (config: TeslaClientConfig) => new TeslaClient(config),
            importerCreator: vi.fn((client: TeslaClient) => {
                importerClients.push(client);
                return importer;
            }) as never,
            tokenExchange: vi.fn().mockResolvedValue({
                id_token: 'id', access_token: 'eu-access', refresh_token: 'eu-refresh', expires_in: 3600,
            }),
            verifyIdToken: vi.fn().mockResolvedValue({ nonce: 'n', sub: 'eu-sub', email: 'eu@example.com' }),
        });
        return { service, userRepo, siteRepo, importer, importerClients };
    }

    const params: TeslaCallbackParams = {
        code: 'c', state: 's', savedState: 's', savedNonce: 'n', callbackUrl: 'http://localhost/callback',
    };

    beforeEach(() => {
        process.env.PUBLIC_TESLA_OAUTH_CLIENT_ID = 'client-id-123';
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('resolves the region first, then imports an EU user\'s sites from the EU host', async () => {
        const fetchMock = euAccountFleet('ok');
        const { service, userRepo, siteRepo, importer, importerClients } = makeService();

        const result = await service.handleTeslaCallback(params);

        expect(result).toMatchObject({ status: 'success', userId: 'eu-sub', siteIds: ['4242'] });
        expect(String(fetchMock.mock.calls[0][0])).toBe(`${NA}/api/1/users/region`);
        // Every call after the region lookup goes straight to the EU host.
        expect(fetchMock.mock.calls.slice(1).every(([url]) => String(url).startsWith(EU))).toBe(true);
        expect(userRepo.upsertOnTeslaAuth).toHaveBeenCalledWith(expect.objectContaining({ userId: 'eu-sub', fleetApiBaseUrl: EU }));
        expect(importerClients[0].getBaseUrl()).toBe(EU);
        expect(importer.ensureSite).toHaveBeenCalledWith('4242');
        expect(siteRepo.assignSiteToUser).toHaveBeenCalledWith('4242', 'eu-sub');
    });

    it('falls back to the 421 base URL when users/region is unavailable', async () => {
        euAccountFleet('down');
        const { service, userRepo, importer } = makeService();

        const result = await service.handleTeslaCallback(params);

        expect(result).toMatchObject({ status: 'success', siteIds: ['4242'] });
        expect(userRepo.upsertOnTeslaAuth).toHaveBeenCalledWith(expect.objectContaining({ fleetApiBaseUrl: EU }));
        expect(importer.ensureSite).toHaveBeenCalledWith('4242');
    });
});
