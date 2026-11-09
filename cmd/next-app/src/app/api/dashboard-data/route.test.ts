import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    const getAuthorizedSiteIds = vi.fn();
    const getSite = vi.fn();
    const getLiveStatus = vi.fn();
    return {
        getAuthorizedSiteIds,
        getSite,
        getLiveStatus
    };
});

vi.mock('@/lib/auth-checks', () => ({
    getAuthorizedSiteIds: mocks.getAuthorizedSiteIds,
}));

vi.mock('@/lib/site-repo', () => ({
    SiteRepo: class {
        getSite = mocks.getSite;
    }
}));

vi.mock('@/lib/tesla-client', () => ({
    TeslaClient: class {
        getLiveStatus = mocks.getLiveStatus;
    }
}));

vi.mock('@/lib/importer', () => ({
    Importer: class {}
}));

import { GET } from './route';

describe('/api/dashboard-data', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getAuthorizedSiteIds.mockResolvedValue(['site-1']);
        mocks.getSite.mockResolvedValue({
            id: 'site-1',
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

    it('does not request site json when loading dashboard products', async () => {
        const response = await GET();
        const body = await response.json();

        expect(mocks.getSite).toHaveBeenNthCalledWith(1, 'site-1');
        expect(mocks.getSite).toHaveBeenNthCalledWith(2, 'site-1');
        expect(body.products).toHaveLength(1);
    });
});
