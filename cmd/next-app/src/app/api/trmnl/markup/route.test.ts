import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    return {
        verifySiteAccess: vi.fn(),
        getSite: vi.fn(),
        getSiteCurrencyCode: vi.fn(),
        getLatestEnergyData: vi.fn(),
        getCycleAggregates: vi.fn(),
        getRawEnergyData: vi.fn(),
        getUsageByTOU: vi.fn(),
        getTariffsForSite: vi.fn(),
        getSchedulesForSite: vi.fn(),
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
        getSiteCurrencyCode = mocks.getSiteCurrencyCode;
    }
}));

vi.mock('@/lib/tariff-repo', () => ({
    TariffRepo: class {
        getTariffsForSite = mocks.getTariffsForSite;
        getSchedulesForSite = mocks.getSchedulesForSite;
    }
}));

vi.mock('@/lib/energy-repo', () => ({
    EnergyRepo: class {
        getLatestEnergyData = mocks.getLatestEnergyData;
        getCycleAggregates = mocks.getCycleAggregates;
        getRawEnergyData = mocks.getRawEnergyData;
        getUsageByTOU = mocks.getUsageByTOU;
        static getSiteMidnight = (d: Date) => d;
        static buildTariffLookupMaps = () => ({ tariffMap: new Map(), scheduleMap: new Map() });
        static aggregateUsageByTOU = () => [];
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
        mocks.getTariffsForSite.mockResolvedValue([]);
        mocks.getSchedulesForSite.mockResolvedValue([]);
    });

    it('renders live and chart sections while clearly withholding an incompletely priced bill',async()=>{
        const {IncompleteTariffAttributionError}=await import('@/lib/billing-availability');
        mocks.getCycleAggregates.mockRejectedValueOnce(new IncompleteTariffAttributionError());
        const response=await GET(new Request('http://localhost/api/trmnl/markup?site_id=site-1&component_config='+encodeURIComponent(JSON.stringify({showEstimatedBill:true,showEnergyChart:true}))));
        expect(response.status).toBe(200);
        const body=await response.json();
        expect(body.markup).toContain('Pricing unavailable');
        expect(body.markup).toContain('--');
        expect(response.headers.get('X-Billing-Status')).toBe('incomplete-attribution');
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
