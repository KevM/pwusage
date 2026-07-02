import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    const getSite = vi.fn();
    const getAuthorizedSites = vi.fn();
    const getLiveStatus = vi.fn();
    const cookies = vi.fn();
    return {
        getSite,
        getAuthorizedSites,
        getLiveStatus,
        cookies
    };
});

vi.mock('next/headers', () => ({
    cookies: mocks.cookies
}));

vi.mock('@/lib/site-repo', () => ({
    SiteRepo: class {
        getSite = mocks.getSite;
    }
}));

vi.mock('@/lib/site-service', () => ({
    SiteService: class {
        getAuthorizedSites = mocks.getAuthorizedSites;
        getLiveStatus = mocks.getLiveStatus;
    }
}));

import { GET } from './route';

describe('/api/dashboard-data', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.cookies.mockResolvedValue({
            get: vi.fn().mockReturnValue({ value: 'some-token' })
        });
        mocks.getAuthorizedSites.mockResolvedValue([{
            id: '123',
            name: 'Home',
            timezone: 'America/Chicago',
        }]);
        mocks.getSite.mockResolvedValue({
            id: '123',
            name: 'Home',
            timezone: 'America/Chicago',
            tariffs: [],
        });
        mocks.getLiveStatus.mockResolvedValue({
            battery_power: 0,
            solar_power: 0,
            load_power: 0,
            grid_power: 0,
            percentage_charged: 50
        });
    });

    it('loads dashboard products using SiteService', async () => {
        const response = await GET();
        const body = await response.json();

        expect(mocks.getAuthorizedSites).toHaveBeenCalled();
        expect(mocks.getLiveStatus).toHaveBeenCalledWith('123');
        expect(mocks.getSite).toHaveBeenCalledWith('123');
        expect(body.products).toHaveLength(1);
        expect(body.products[0]).toEqual({
            id: '123',
            site_name: 'Home',
            energy_site_id: 123,
            percentage_charged: 50,
            currentTariff: 'Unknown',
            liveBatteryPower: 0,
            liveSolarPower: 0,
            liveLoadPower: 0,
            liveGridPower: 0
        });
    });
});

