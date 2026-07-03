import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
    createTeslaClientForSite,
    createTeslaClientForUser,
    createTeslaClientForAccessToken
} from './tesla-client-factory';
import { TeslaClient } from './tesla-client';

const mockGetTokensForSite = vi.fn();
const mockGetTokens = vi.fn();

vi.mock('./user-repo', () => {
    return {
        UserRepo: function UserRepo() {
            return {
                getTokensForSite: mockGetTokensForSite,
                getTokens: mockGetTokens
            };
        }
    };
});

vi.mock('./site-repo', () => {
    return {
        SiteRepo: function SiteRepo() {
            return {};
        }
    };
});

vi.mock('./tesla-token-repo', () => {
    return {
        TeslaTokenRepo: function TeslaTokenRepo() {
            return {
                getLockedRefreshHandler: vi.fn().mockReturnValue({
                    refreshHandler: vi.fn(),
                    errorHandler: vi.fn()
                })
            };
        }
    };
});

describe('TeslaClientFactory', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('createTeslaClientForSite', () => {
        it('returns null if no tokens or no refresh_token exists for site', async () => {
            mockGetTokensForSite.mockResolvedValue(null);
            const client1 = await createTeslaClientForSite('site-1');
            expect(client1).toBeNull();

            mockGetTokensForSite.mockResolvedValue({ access_token: 'acc' });
            const client2 = await createTeslaClientForSite('site-1');
            expect(client2).toBeNull();
        });

        it('returns TeslaClient when refresh_token exists', async () => {
            mockGetTokensForSite.mockResolvedValue({
                access_token: 'acc-token',
                refresh_token: 'ref-token'
            });

            const client = await createTeslaClientForSite('site-1');
            expect(client).toBeInstanceOf(TeslaClient);
        });
    });

    describe('createTeslaClientForUser', () => {
        it('returns null if user has no tokens or no access_token', async () => {
            mockGetTokens.mockResolvedValue(null);
            const client1 = await createTeslaClientForUser('user-1');
            expect(client1).toBeNull();

            mockGetTokens.mockResolvedValue({});
            const client2 = await createTeslaClientForUser('user-1');
            expect(client2).toBeNull();
        });

        it('returns TeslaClient when access_token exists for user', async () => {
            mockGetTokens.mockResolvedValue({
                access_token: 'acc-token',
                refresh_token: 'ref-token'
            });

            const client = await createTeslaClientForUser('user-1');
            expect(client).toBeInstanceOf(TeslaClient);
        });
    });

    describe('createTeslaClientForAccessToken', () => {
        it('creates TeslaClient directly from access token', () => {
            const client = createTeslaClientForAccessToken('raw-access-token');
            expect(client).toBeInstanceOf(TeslaClient);
        });
    });
});
