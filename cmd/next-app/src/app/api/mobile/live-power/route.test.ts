import { beforeEach, describe, expect, it, vi } from 'vitest';

const { verifyAccess, refresh } = vi.hoisted(() => ({ verifyAccess: vi.fn(), refresh: vi.fn() }));
vi.mock('@/lib/auth-checks', () => ({ verifySiteAccess: verifyAccess }));
vi.mock('@/lib/today-refresh', () => ({ refreshLiveStatus: refresh }));
// The fast route must never construct a repository or read history.
vi.mock('@/lib/energy-repo-factory', () => ({ createEnergyRepo: () => { throw new Error('History read'); } }));

import { GET } from './route';

const request = () => new Request('https://example.test/api/mobile/live-power?siteId=site-a');

describe('foreground live power', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        verifyAccess.mockResolvedValue(true);
        refresh.mockResolvedValue({ status: 'refreshed', liveStatus: {
            timestamp: new Date().toISOString(), percentage_charged: 73,
            solar_power: 1200, load_power: 900, battery_power: -500, grid_power: 200,
        } });
    });

    it('returns only power and charge, independent of energy/history/rate-plan reads', async () => {
        const response = await GET(request());
        const body = await response.json();
        expect(response.status).toBe(200);
        expect(body).toEqual({
            version: 1, siteID: 'site-a', stateOfCharge: 73,
            live: { solarPower: 1200, loadPower: 900, batteryPower: -500, gridPower: 200 },
            sources: { liveStatusAt: expect.any(String), stateOfChargeAt: expect.any(String) },
        });
        expect(refresh).toHaveBeenCalledWith('site-a', { force: true, liveOnly: true });
        expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    });

    it('authorizes before asking Tesla for a reading', async () => {
        verifyAccess.mockResolvedValue(false);
        expect((await GET(request())).status).toBe(401);
        expect(refresh).not.toHaveBeenCalled();
        expect((await GET(new Request('https://example.test/api/mobile/live-power'))).status).toBe(400);
    });

    it('does not stamp old cached charge as fresh', async () => {
        refresh.mockResolvedValue({ status: 'cached', liveStatus: {
            timestamp: new Date(Date.now() - 3 * 3600_000).toISOString(), percentage_charged: 73,
            solar_power: 1200, load_power: 900, battery_power: -500, grid_power: 200,
        } });
        const body = await (await GET(request())).json();
        expect(body.stateOfCharge).toBeNull();
        expect(body.sources.stateOfChargeAt).toBeNull();
        expect(Date.parse(body.sources.liveStatusAt)).toBeLessThan(Date.now() - 2 * 3600_000);
    });

    it('returns a retryable failure for missing readings, without leaking Tesla errors', async () => {
        refresh.mockResolvedValue({ status: 'error', errorMessage: 'private upstream detail' });
        const response = await GET(request());
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ error: 'Live readings unavailable' });
        refresh.mockResolvedValue({ status: 'no-tokens' });
        expect((await GET(request())).status).toBe(409);
        refresh.mockResolvedValue({ status: 'connection-required' });
        const reconnect = await GET(request());
        expect(reconnect.status).toBe(409);
        expect(await reconnect.json()).toMatchObject({ code: 'TESLA_CONNECTION_REQUIRED' });
    });
});
