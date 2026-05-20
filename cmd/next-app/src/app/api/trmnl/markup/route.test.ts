import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    return {
        verifySiteAccess: vi.fn(),
        getSite: vi.fn(),
        getLatestEnergyData: vi.fn(),
        getCycleAggregates: vi.fn(),
        getRawEnergyData: vi.fn(),
        getUsageByTOU: vi.fn(),
        after: vi.fn(),
    };
});

vi.mock('next/server', async (importOriginal) => {
    const actual = await importOriginal<typeof import('next/server')>();
    return {
        ...actual,
        after: mocks.after,
    };
});

vi.mock('@/lib/auth-checks', () => ({
    verifySiteAccess: mocks.verifySiteAccess
}));

vi.mock('@/lib/site-repo', () => ({
    SiteRepo: class {
        getSite = mocks.getSite;
    }
}));

vi.mock('@/lib/energy-repo', () => ({
    EnergyRepo: class {
        getLatestEnergyData = mocks.getLatestEnergyData;
        getCycleAggregates = mocks.getCycleAggregates;
        getRawEnergyData = mocks.getRawEnergyData;
        getUsageByTOU = mocks.getUsageByTOU;
        static getSiteMidnight = (d: Date) => d;
    },
    sumTodayRows: () => ({ homeKwh: 0, gridNetKwh: 0, solarKwh: 0 })
}));

vi.mock('@/lib/tesla-token-repo', () => ({
    TeslaTokenRepo: class {
        getLockedRefreshHandler = () => ({ refreshHandler: vi.fn(), errorHandler: vi.fn() });
    }
}));

vi.mock('@/lib/db', () => ({
    pool: {
        query: vi.fn()
    }
}));

import { GET } from './route';

describe('/api/trmnl/markup', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.verifySiteAccess.mockResolvedValue(true);
        mocks.getSite.mockResolvedValue({
            id: 'site-1',
            name: 'Harrison',
            timezone: 'America/Chicago',
            tariffs: [],
            billing_start_day: 1
        });
        mocks.getLatestEnergyData.mockResolvedValue(null);
        mocks.getCycleAggregates.mockResolvedValue([]);
        mocks.getRawEnergyData.mockResolvedValue([]);
    });

    it('augments the site name with the generation timestamp in the site timezone', async () => {
        const mockTime = new Date('2026-05-20T12:30:00Z'); // 12:30 UTC -> 7:30 AM in America/Chicago
        vi.useFakeTimers();
        vi.setSystemTime(mockTime);

        const response = await GET(new Request('http://localhost/api/trmnl/markup?site_id=site-1'));
        const body = await response.json();

        expect(body.markup).toContain('Harrison @ 7:30am');

        vi.useRealTimers();
    });
});
