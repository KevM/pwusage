import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    const getAuthorizedSiteIds = vi.fn();
    const getTeslaCredentials = vi.fn();
    const getSite = vi.fn();
    const getLockedRefreshHandler = vi.fn();
    const getLiveStatus = vi.fn();
    return {
        getAuthorizedSiteIds,
        getTeslaCredentials,
        getSite,
        getLockedRefreshHandler,
        getLiveStatus
    };
});

vi.mock('@/lib/auth-checks', () => ({
    getAuthorizedSiteIds: mocks.getAuthorizedSiteIds,
    getTeslaCredentials: mocks.getTeslaCredentials
}));

vi.mock('@/lib/tesla-token-repo', () => ({
    TeslaTokenRepo: class {
        getLockedRefreshHandler = mocks.getLockedRefreshHandler;
    }
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
        mocks.getTeslaCredentials.mockResolvedValue({ access_token: 'a', refresh_token: 'r' });
        mocks.getLockedRefreshHandler.mockReturnValue({
            refreshHandler: vi.fn(),
            errorHandler: vi.fn()
        });
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
