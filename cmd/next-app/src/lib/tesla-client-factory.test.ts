import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import {
    createTeslaClientForSite,
    createTeslaClientForUser,
    createTeslaClientForAccessToken
} from './tesla-client-factory';
import { TeslaClient } from './tesla-client';

const mockGetTokensForSite = vi.fn();
const mockGetTokens = vi.fn();
const mockSetFleetApiBaseUrl = vi.fn();
const mockUserRefresh = vi.fn();
const EU = 'https://fleet-api.prd.eu.vn.cloud.tesla.com';

vi.mock('./user-repo', () => {
    return {
        UserRepo: function UserRepo() {
            return {
                getTokensForSite: mockGetTokensForSite,
                getTokens: mockGetTokens,
                setFleetApiBaseUrl: mockSetFleetApiBaseUrl
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
                }),
                getLockedUserRefreshHandler: vi.fn().mockReturnValue({
                    refreshHandler: mockUserRefresh,
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

    afterEach(() => {
        vi.restoreAllMocks();
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

        it("uses the owner's stored Fleet host and persists a learned one", async () => {
            mockGetTokensForSite.mockResolvedValue({
                access_token: 'acc-token',
                refresh_token: 'ref-token',
                user_id: 'user-1',
                fleet_api_base_url: null
            });

            const client = await createTeslaClientForSite('site-1');
            expect(client?.getBaseUrl()).toBe('https://fleet-api.prd.na.vn.cloud.tesla.com');

            mockGetTokensForSite.mockResolvedValue({
                access_token: 'acc-token',
                refresh_token: 'ref-token',
                user_id: 'user-1',
                fleet_api_base_url: EU
            });
            const euClient = await createTeslaClientForSite('site-1');
            expect(euClient?.getBaseUrl()).toBe(EU);

            vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ response: { region: 'eu', fleet_api_base_url: EU } }),
            } as unknown as Response);
            await client?.resolveRegion();
            expect(mockSetFleetApiBaseUrl).toHaveBeenCalledWith('user-1', EU);
        });
    });

    describe('createTeslaClientForUser', () => {
        it('uses account refresh coordination when a browser Fleet request gets a 401', async () => {
            mockGetTokens.mockResolvedValue({ access_token: 'old-access', refresh_token: 'old-refresh' });
            mockUserRefresh.mockResolvedValue({ access_token: 'new-access', refresh_token: 'new-refresh' });
            const fetchMock = vi.spyOn(globalThis, 'fetch')
                .mockResolvedValueOnce(new Response('', { status: 401 }))
                .mockResolvedValueOnce(Response.json({ response: [] }));
            const client = await createTeslaClientForUser('user-1');
            await client?.getProducts();
            expect(mockUserRefresh).toHaveBeenCalledWith('old-refresh');
            expect(fetchMock.mock.calls[1][1]?.headers).toMatchObject({ Authorization: 'Bearer new-access' });
        });
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

        it("uses the user's stored Fleet host", async () => {
            mockGetTokens.mockResolvedValue({
                access_token: 'acc-token',
                refresh_token: 'ref-token',
                fleet_api_base_url: EU
            });

            const client = await createTeslaClientForUser('user-1');
            expect(client?.getBaseUrl()).toBe(EU);
        });
    });

    describe('createTeslaClientForAccessToken', () => {
        it('creates TeslaClient directly from access token', () => {
            const client = createTeslaClientForAccessToken('raw-access-token');
            expect(client).toBeInstanceOf(TeslaClient);
        });

        it('accepts a stored Fleet host', () => {
            const client = createTeslaClientForAccessToken('raw-access-token', undefined, { baseUrl: EU });
            expect(client.getBaseUrl()).toBe(EU);
        });

        it('persists a learned Fleet host for the token owner', async () => {
            const client = createTeslaClientForAccessToken('raw-access-token', undefined, { userId: 'user-1' });

            vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
                ok: false,
                status: 421,
                text: async () => `user out of region, use base URL: ${EU}`,
            } as unknown as Response).mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ response: [], count: 0 }),
            } as unknown as Response);

            await client.getProducts();

            expect(client.getBaseUrl()).toBe(EU);
            expect(mockSetFleetApiBaseUrl).toHaveBeenCalledWith('user-1', EU);
        });
    });
});
