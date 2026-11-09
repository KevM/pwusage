import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import {
    createTeslaClientForSite,
    createTeslaClientForSiteMember,
    createTeslaClientForUser,
    createTeslaClientForAccessToken
} from './tesla-client-factory';
import { TeslaClient } from './tesla-client';

const mockGetTokensForSite = vi.fn();
const mockGetTokensForSiteMember = vi.fn();
const mockGetTokens = vi.fn();
const mockSetFleetApiBaseUrl = vi.fn();
const mockUserRefresh = vi.fn();
const mockRepairConnection = vi.fn();
const EU = 'https://fleet-api.prd.eu.vn.cloud.tesla.com';

vi.mock('./user-repo', () => {
    return {
        UserRepo: function UserRepo() {
            return {
                getTokensForSite: mockGetTokensForSite,
                getTokensForSiteMember: mockGetTokensForSiteMember,
                getTokens: mockGetTokens,
                setFleetApiBaseUrl: mockSetFleetApiBaseUrl
            };
        }
    };
});

vi.mock('./site-repo', () => {
    return {
        SiteRepo: function SiteRepo() {
            return { repairConnection: mockRepairConnection };
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
        mockGetTokensForSiteMember.mockResolvedValue({ access_token: 'acc-token', refresh_token: 'ref-token', tesla_energy_site_id: 'site-1', is_active: true, tesla_refresh_state: 'ready' });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('createTeslaClientForSite', () => {
        it('repairs an unusable connection before selecting a pinned account', async () => {
            vi.stubEnv('SITE_MEMBERSHIP_ENABLED', 'true');
            try {
                mockGetTokensForSite.mockResolvedValueOnce({ refresh_token: null, user_id: 'old', is_active: true })
                    .mockResolvedValueOnce({ access_token: 'new-token', refresh_token: 'new-refresh', user_id: 'new', is_active: true });
                const client = await createTeslaClientForSite('home');
                expect(client).toBeInstanceOf(TeslaClient);
                expect(mockRepairConnection).toHaveBeenCalledWith('home');
                expect(mockGetTokensForSite).toHaveBeenCalledTimes(2);
            } finally {
                vi.unstubAllEnvs();
            }
        });
        it('pins an invited member without reading the connection grant', async () => {
            mockGetTokensForSiteMember.mockResolvedValue({ access_token: 'invite-token', refresh_token: 'invite-refresh', tesla_energy_site_id: 'invite-id', is_active: true, tesla_refresh_state: 'ready' });
            const client = await createTeslaClientForSiteMember('home', 'invited');
            const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ response: {} }));
            await client?.getLiveStatus('home');
            expect(mockGetTokensForSite).not.toHaveBeenCalled();
            expect(mockGetTokensForSiteMember).toHaveBeenCalledWith('home', 'invited');
            expect(new URL(String(fetchMock.mock.calls[0][0])).pathname).toContain('/energy_sites/invite-id/live_status');
            expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({ Authorization: 'Bearer invite-token' });
        });
        it('checks current connection state again before using a constructed client', async () => {
            mockGetTokensForSite.mockResolvedValue({ access_token: 'a', refresh_token: 'r', user_id: 'u', is_active: true, tesla_refresh_state: 'ready' });
            mockGetTokensForSiteMember.mockResolvedValue({ access_token: 'a', refresh_token: 'r', tesla_energy_site_id: 'site-1', is_active: true, tesla_refresh_state: 'uncertain' });
            const client = await createTeslaClientForSite('site-1');
            const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ response: [] }));
            await expect(client?.getProducts()).rejects.toMatchObject({ code: 'TESLA_CONNECTION_REQUIRED' });
            expect(fetchMock).not.toHaveBeenCalled();
            expect(mockGetTokensForSiteMember).toHaveBeenCalledWith('site-1', 'u');
        });

        it('does not adopt another account after the site connection moves', async () => {
            mockGetTokensForSite.mockResolvedValue({ access_token: 'a-token', refresh_token: 'a-refresh', user_id: 'account-a', is_active: true, tesla_refresh_state: 'ready' });
            mockGetTokensForSiteMember.mockResolvedValue({ access_token: 'a-token', refresh_token: 'a-refresh', tesla_energy_site_id: 'a-site', is_active: true, tesla_refresh_state: 'ready' });
            const client = await createTeslaClientForSite('site-1');
            mockGetTokensForSite.mockResolvedValue({ access_token: 'b-token', refresh_token: 'b-refresh', user_id: 'account-b', is_active: true, tesla_refresh_state: 'ready' });
            const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ response: [] }));
            await client?.getProducts();
            expect(mockGetTokensForSiteMember).toHaveBeenCalledWith('site-1', 'account-a');
            expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({ Authorization: 'Bearer a-token' });
        });

        it('uses the pinned member’s current Tesla ID and rejects a missing mapping', async () => {
            mockGetTokensForSite.mockResolvedValue({ access_token: 'a-token', refresh_token: 'a-refresh', user_id: 'account-a', tesla_energy_site_id: 'old-id' });
            mockGetTokensForSiteMember.mockResolvedValue({ access_token: 'a-token', refresh_token: 'a-refresh', tesla_energy_site_id: 'new-id', is_active: true, tesla_refresh_state: 'ready' });
            const client = await createTeslaClientForSite('pwusage-site');
            const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ response: {} }));
            await client?.getLiveStatus('pwusage-site');
            expect(new URL(String(fetchMock.mock.calls[0][0])).pathname).toContain('/energy_sites/new-id/live_status');
            mockGetTokensForSiteMember.mockResolvedValue({ access_token: 'a-token', refresh_token: 'a-refresh', is_active: true, tesla_refresh_state: 'ready' });
            await expect(client?.getLiveStatus('pwusage-site')).rejects.toThrow(/mapping missing/);
            expect(fetchMock).toHaveBeenCalledTimes(1);
        });

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
                refresh_token: 'ref-token',
                user_id: 'user-1'
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

        it('refreshes an account-backed client through the account lease, never directly', async () => {
            mockGetTokens.mockResolvedValue({ access_token: 'old-access', refresh_token: 'account-refresh', is_active: true, tesla_refresh_state: 'ready' });
            mockUserRefresh.mockResolvedValue({ access_token: 'new-access', refresh_token: 'new-refresh' });
            const direct = vi.spyOn(TeslaClient, 'refreshAccessToken');
            const fetchMock = vi.spyOn(globalThis, 'fetch')
                .mockResolvedValueOnce(new Response('', { status: 401 }))
                .mockResolvedValueOnce(Response.json({ response: [] }));
            const client = createTeslaClientForAccessToken('old-access', undefined, { userId: 'user-1' });
            await client.getProducts();
            expect(direct).not.toHaveBeenCalled();
            expect(mockUserRefresh).toHaveBeenCalledWith('account-refresh');
            expect(fetchMock.mock.calls[1][1]?.headers).toMatchObject({ Authorization: 'Bearer new-access' });
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
