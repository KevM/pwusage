import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    return {
        verifySiteAccess: vi.fn(),
        findByUuidWithSite: vi.fn(),
        getSite: vi.fn(),
        getSiteCurrencyCode: vi.fn(),
        getLatestEnergyData: vi.fn(),
        getCycleAggregates: vi.fn(),
        getRawEnergyData: vi.fn(),
        getUsageByTOU: vi.fn(),
        getTariffsForSite: vi.fn(),
        getSchedulesForSite: vi.fn(),
        after: vi.fn(),
        refreshLive: vi.fn(),
        refreshToday: vi.fn(),
    };
});

vi.mock('next/server', async (importOriginal) => {
    const actual = await importOriginal<typeof import('next/server')>();
    return {
        ...actual,
        after: mocks.after,
    };
});

vi.mock('@/lib/today-refresh', () => ({ refreshLiveStatus: mocks.refreshLive, refreshTodayData: mocks.refreshToday }));

vi.mock('@/lib/auth-checks', () => ({
    verifySiteAccess: mocks.verifySiteAccess
}));

vi.mock('@/lib/trmnl-installation-repo', () => ({
    TrmnlInstallationRepo: class {
        findByUuidWithSite = mocks.findByUuidWithSite;
        updateCarouselIndex = vi.fn();
    }
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

    it.each(['old', 'missing', 'future'])('does not treat a recently cached %s source as fresh SOC', async kind => {
        const timestamp = kind === 'missing' ? undefined
            : new Date(Date.now() + (kind === 'old' ? -3600000 : 3600000)).toISOString();
        mocks.getSite.mockResolvedValue({
            id: 'site-1', name: 'Home', timezone: 'UTC', tariffs: [],
            last_live_refresh_at: Date.now(), live_status_cache: { percentage_charged: 87, timestamp },
        });
        const response = await GET(new Request('https://pwusage.test/api/trmnl/markup?site_id=site-1'));
        expect(response.status).toBe(200);
        expect(response.headers.get('X-SOC-Age-Minutes')).toMatch(/^stale:/);
    });

    it('returns DB markup on a cache miss without awaiting Tesla', async () => {
        mocks.getSite.mockResolvedValue({ id: 'site-1', name: 'Home', timezone: 'UTC', tariffs: [], refresh_token: 'r' });
        mocks.refreshLive.mockImplementation(() => new Promise(() => {}));
        const response = await GET(new Request('http://localhost/api/trmnl/markup?site_id=site-1'));
        expect(response.status).toBe(200);
        expect(mocks.refreshLive).not.toHaveBeenCalled();
        expect(mocks.after).toHaveBeenCalled();
    }, 1000);

    it.each(['uncertain', 'reconnect_required'])('renders stored data and a reconnect message for %s', async state => {
        mocks.getSite.mockResolvedValue({ id: 'site-1', name: 'Home', timezone: 'UTC', tariffs: [], refresh_token: 'r', tesla_refresh_state: state });
        const response = await GET(new Request('http://localhost/api/trmnl/markup?site_id=site-1'));
        const body = await response.json();
        expect(response.status).toBe(200);
        for (const markup of Object.values(body)) expect(markup).toContain('Reconnect Tesla to update your data.');
        expect(mocks.refreshLive).not.toHaveBeenCalled();
        expect(mocks.after).not.toHaveBeenCalled();
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

    // Session revocation (sign-out-everywhere) must not affect TRMNL device
    // polling: devices authenticate with installation bearer tokens, never
    // site_auth. This test forces the human authz check to fail and still
    // expects the device path to render.
    it('renders device (uuid) polls authenticated by installation bearer token without consulting session auth', async () => {
        mocks.verifySiteAccess.mockResolvedValue(false); // revoked human session
        mocks.findByUuidWithSite.mockResolvedValue({
            installation: {
                id: 'inst-1',
                uuid: 'device-uuid-1',
                access_token: 'device-token',
                json: null,
            },
            site: {
                id: 'site-1',
                name: 'Harrison',
                timezone: 'America/Chicago',
                tariffs: [],
                billing_start_day: 1,
            },
        });

        const response = await GET(new Request('http://localhost/api/trmnl/markup?uuid=device-uuid-1', {
            headers: { Authorization: 'Bearer device-token' },
        }));

        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.markup).toContain('Harrison');
        // Human session authz must not be consulted on the device path.
        expect(mocks.verifySiteAccess).not.toHaveBeenCalled();
    });

    it('rejects a device poll whose bearer token does not match the installation', async () => {
        mocks.verifySiteAccess.mockResolvedValue(false);
        mocks.findByUuidWithSite.mockResolvedValue({
            installation: {
                id: 'inst-1',
                uuid: 'device-uuid-1',
                access_token: 'device-token',
                json: null,
            },
            site: {
                id: 'site-1',
                name: 'Harrison',
                timezone: 'America/Chicago',
                tariffs: [],
                billing_start_day: 1,
            },
        });

        const response = await GET(new Request('http://localhost/api/trmnl/markup?uuid=device-uuid-1', {
            headers: { Authorization: 'Bearer wrong-token' },
        }));

        const body = await response.json();
        expect(body.markup).toContain('Plugin Auth Failed');
        expect(mocks.verifySiteAccess).not.toHaveBeenCalled();
    });

    // Preview mode is human auth: it must go through verifySiteAccess, which
    // now enforces active status and session_version.
    it('rejects preview (site_id) polls when the human session is revoked', async () => {
        mocks.verifySiteAccess.mockResolvedValue(false);

        const response = await GET(new Request('http://localhost/api/trmnl/markup?site_id=site-1'));

        expect(response.status).toBe(401);
        expect(mocks.verifySiteAccess).toHaveBeenCalledWith('site-1');
        expect(mocks.getSite).not.toHaveBeenCalled();
    });
});
