import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { verifyAccessMock, refreshMock, refreshTodayMock, siteMock, bucketedMock, usageMock, rawMock, latestSocMock } = vi.hoisted(() => ({
    verifyAccessMock: vi.fn(),
    refreshMock: vi.fn(),
    refreshTodayMock: vi.fn(),
    siteMock: vi.fn(),
    bucketedMock: vi.fn(),
    usageMock: vi.fn(),
    rawMock: vi.fn(),
    latestSocMock: vi.fn(),
}));

vi.mock('@/lib/auth-checks', () => ({ verifySiteAccess: verifyAccessMock }));
vi.mock('@/lib/today-refresh', () => ({ refreshLiveStatus: refreshMock, refreshTodayData: refreshTodayMock }));
vi.mock('@/lib/site-repo', () => ({ SiteRepo: class { getSite = siteMock; getSiteCurrencyCode = async () => 'EUR'; } }));
vi.mock('@/lib/energy-repo', () => ({
    sumTodayRows: () => ({
        homeKwh: 0, solarKwh: 0, gridNetKwh: 0, importKwh: 0, exportKwh: 0,
        batteryNetKwh: 0, latestBatterySoc: null,
    }),
    EnergyRepo: class {
        getBucketedEnergyData = bucketedMock;
        getUsageByTOU = usageMock;
        getRawEnergyData = rawMock;
        getLatestBatterySoc = latestSocMock;
        static getSiteMidnight(date: Date) { return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())); }
    },
}));

import { GET } from './route';
import { clearCycleRollupCache } from '@/lib/cycle-rollup-cache';

function makeCurrentTariffs(
    scheduleName: string | null = 'All day',
    seasonFromMonth = 1,
    seasonToMonth = 12
) {
    return [{
        id: 1, site_id: 'site-a', name: 'Current', updated: new Date('2026-01-01'),
        seasons: [{
            id: 2, tariff_id: 1, name: 'All year', from_month: seasonFromMonth, from_day: 1,
            to_month: seasonToMonth, to_day: 31,
            buy_rate: 0.2, sell_rate: 0.05,
            schedules: [{
                id: 3, season_id: 2, name: scheduleName, buy_rate: 0.2, sell_rate: 0.05,
                from_day_of_week: 0, to_day_of_week: 6, from_hour: null, from_minute: null,
                to_hour: null, to_minute: null,
            }],
        }],
    }];
}

describe('site-live-data mobile response', () => {
    afterEach(() => vi.useRealTimers());
    beforeEach(() => {
        // Keep relative fixture samples in today's UTC window, even when CI runs just after midnight.
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-09-24T12:00:00.000Z'));
        vi.resetAllMocks();
        clearCycleRollupCache();
        const now = new Date();
        verifyAccessMock.mockResolvedValue(true);
        siteMock.mockResolvedValue({
            id: 'site-a', name: 'Home', timezone: 'UTC', billing_start_day: 1, tariffs: makeCurrentTariffs(),
        });
        refreshMock.mockResolvedValue({
            status: 'cached', fetchedAt: now.getTime() - 30 * 60 * 1000,
            liveStatus: {
                solar_power: 1200, load_power: 900, battery_power: -100, grid_power: 200,
                percentage_charged: 73, timestamp: new Date(now.getTime() - 30 * 60 * 1000).toISOString(),
            },
        });
        bucketedMock.mockResolvedValue([]);
        usageMock.mockResolvedValue([]);
        refreshTodayMock.mockResolvedValue({ status: 'no-new-rows' });
        latestSocMock.mockResolvedValue(null);
    });

    it('limits mobile summary history to the site-local day instead of the sparkline scale window', async () => {
        await GET(new Request('https://example.test/api/site-live-data?siteId=site-a&view=mobile'));
        expect(bucketedMock).toHaveBeenCalledWith('site-a', new Date('2026-09-24T00:00:00Z'), new Date());
        bucketedMock.mockClear();
        await GET(new Request('https://example.test/api/site-live-data?siteId=site-a'));
        const [, start] = bucketedMock.mock.calls[0] as [string, Date, Date];
        expect(start.getTime()).toBeLessThan(new Date('2026-09-24T00:00:00Z').getTime());
    });

    it('publishes daily canonical tariff charges and credits in the site currency', async () => {
        usageMock.mockImplementation(async (_site, start) => start.toISOString() === '2026-09-24T00:00:00.000Z'
            ? [{ cost: 3.12, touName: 'Peak' }, { cost: -0.65, touName: 'Off peak' }] : []);
        const response = await GET(new Request('https://example.test/api/site-live-data?siteId=site-a&view=mobile'));
        expect((await response.json()).todayCost).toEqual({ netCost: 2.47, importCharges: 3.12, exportCredits: 0.65, currency: 'EUR' });
        expect(usageMock).toHaveBeenCalledWith('site-a', new Date('2026-09-24T00:00:00Z'), new Date());
    });

    it('keeps energy available when daily pricing fails', async () => {
        usageMock.mockRejectedValue(new Error('pricing unavailable'));
        const response = await GET(new Request('https://example.test/api/site-live-data?siteId=site-a&view=mobile'));
        expect(response.status).toBe(200);
        expect((await response.json()).todayCost).toBeNull();
    });

    it('does not display zero cost for absent or unresolved daily pricing', async () => {
        for (const rows of [[], [{ cost: 0, touName: 'Unknown' }], [{ cost: NaN, touName: 'Peak' }]]) {
            usageMock.mockResolvedValue(rows);
            const response = await GET(new Request('https://example.test/api/site-live-data?siteId=site-a&view=mobile'));
            expect((await response.json()).todayCost).toBeNull();
        }
    });

    it('preserves a net credit and a legitimate zero-cost day', async () => {
        for (const cost of [-2.5, 0]) {
            usageMock.mockResolvedValue([{ cost, touName: 'Off peak' }]);
            const response = await GET(new Request('https://example.test/api/site-live-data?siteId=site-a&view=mobile'));
            expect((await response.json()).todayCost).toEqual({ netCost: cost, importCharges: 0, exportCredits: Math.max(-cost, 0), currency: 'EUR' });
        }
    });

    it('returns the compact mobile contract with last-known SoC without raw-day reads', async () => {
        const response = await GET(new Request('https://example.test/api/site-live-data?siteId=site-a&view=mobile'));
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.version).toBe(1);
        expect(body.site.id).toBe('site-a');
        expect(body.stateOfCharge).toBe(73);
        expect(body.sources.stateOfChargeAt).toBeTruthy();
        expect(body.currentBill).toBeNull();
        expect(body.activeLoadTiming).toEqual({
            periodName: 'All day', buyRate: 0.2, sellRate: 0.05,
            marginalCost: 0.2, basis: 'unobserved', balanceKwh: null, energyDataThrough: null,
        });
        expect(bucketedMock).toHaveBeenCalledTimes(1);
        expect(usageMock).toHaveBeenCalledTimes(2);
        const [, , rollupEnd] = usageMock.mock.calls[0] as [string, Date, Date];
        expect(rollupEnd.getTime()).toBeLessThan(Date.now());
        expect(rawMock).not.toHaveBeenCalled();
        expect(latestSocMock).not.toHaveBeenCalled();
    });

    it('normalizes a valid unnamed active period to Standard for the mobile summary and web headroom', async () => {
        siteMock.mockResolvedValue({
            id: 'site-a', name: 'Home', timezone: 'UTC', billing_start_day: 1,
            tariffs: makeCurrentTariffs(null),
        });
        const sampleTimestamp = new Date(Date.now() - 2 * 60 * 1000);
        bucketedMock.mockResolvedValue([{
            timestamp: new Date(Math.floor(sampleTimestamp.getTime() / (15 * 60 * 1000)) * (15 * 60 * 1000)),
            sample_timestamp: sampleTimestamp, site_id: 'site-a', tariff_id: 1, tariff_schedule_id: 3,
            load_power: 0, solar_power: 0, grid_power: -1000, battery_power: 0, battery_soc: null,
            sample_count: 1,
        }]);

        const mobileResponse = await GET(new Request('https://example.test/api/site-live-data?siteId=site-a&view=mobile'));
        const mobileBody = await mobileResponse.json();
        expect(mobileBody.activeLoadTiming.periodName).toBe('Standard');
        expect(mobileBody.activeLoadTiming.balanceKwh).toBe(1);

        clearCycleRollupCache();
        const webResponse = await GET(new Request('https://example.test/api/site-live-data?siteId=site-a'));
        const webBody = await webResponse.json();
        expect(webBody.loadHeadroom.periodName).toBe('Standard');
        expect(webBody.loadHeadroom.surplusKwh).toBe(1);
    });

    it('does not invent a Standard period when no active tariff period exists', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-24T12:00:00.000Z'));
        siteMock.mockResolvedValue({
            id: 'site-a', name: 'Home', timezone: 'UTC', billing_start_day: 1,
            tariffs: makeCurrentTariffs('Winter', 1, 1),
        });
        const response = await GET(new Request('https://example.test/api/site-live-data?siteId=site-a&view=mobile'));
        const body = await response.json();

        expect(body.activeLoadTiming).toBeNull();
        expect(usageMock).toHaveBeenCalledTimes(1);
    });

    it('uses one narrow stored SoC lookup when Tesla omits the charge value', async () => {
        refreshMock.mockResolvedValue({
            status: 'refreshed', liveStatus: {
                solar_power: 1200, load_power: 900, battery_power: -100, grid_power: 200,
                percentage_charged: null, timestamp: new Date().toISOString(),
            },
        });
        latestSocMock.mockResolvedValue({ value: 68, timestamp: new Date(Date.now() - 30 * 60 * 1000) });

        const response = await GET(new Request('https://example.test/api/site-live-data?siteId=site-a&view=mobile'));
        const body = await response.json();

        expect(body.stateOfCharge).toBe(68);
        expect(body.sources.stateOfChargeAt).toBeTruthy();
        expect(latestSocMock).toHaveBeenCalledTimes(1);
        expect(rawMock).not.toHaveBeenCalled();
    });

    it('refreshes stale mobile energy history and returns the new sample in the same response', async () => {
        const oldSample = new Date(Date.now() - 2 * 60 * 60 * 1000);
        const newSample = new Date(Date.now() - 5 * 60 * 1000);
        const row = (sample: Date) => ({
            timestamp: sample, sample_timestamp: sample,
            site_id: 'site-a', tariff_id: 1, tariff_schedule_id: 3,
            load_power: 900, solar_power: 1200, grid_power: 200, battery_power: -100,
            battery_soc: null, sample_count: 1,
        });
        bucketedMock.mockResolvedValueOnce([row(oldSample)]).mockResolvedValueOnce([row(oldSample), row(newSample)]);
        refreshTodayMock.mockResolvedValue({ status: 'persisted', rowsPersisted: 1 });

        const response = await GET(new Request('https://example.test/api/site-live-data?siteId=site-a&view=mobile'));
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(refreshTodayMock).toHaveBeenCalledWith('site-a', { minIntervalMs: 30 * 60 * 1000 });
        expect(bucketedMock).toHaveBeenCalledTimes(2);
        expect(body.sources.energyDataThrough).toBe(newSample.toISOString());
    });

    it('does not refresh Tesla history when the mobile energy sample is recent', async () => {
        const sample = new Date(Date.now() - 5 * 60 * 1000);
        bucketedMock.mockResolvedValue([{
            timestamp: sample, sample_timestamp: sample,
            site_id: 'site-a', tariff_id: 1, tariff_schedule_id: 3,
            load_power: 900, solar_power: 1200, grid_power: 200, battery_power: -100,
            battery_soc: null, sample_count: 1,
        }]);

        await GET(new Request('https://example.test/api/site-live-data?siteId=site-a&view=mobile'));

        expect(refreshTodayMock).not.toHaveBeenCalled();
        expect(bucketedMock).toHaveBeenCalledTimes(1);
    });

    it('keeps the stale response without another bucket read when refresh yields no new samples', async () => {
        refreshTodayMock.mockResolvedValue({ status: 'no-new-rows' });

        const response = await GET(new Request('https://example.test/api/site-live-data?siteId=site-a&view=mobile'));
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.sources.energyDataThrough).toBeNull();
        expect(refreshTodayMock).toHaveBeenCalledTimes(1);
        expect(bucketedMock).toHaveBeenCalledTimes(1);
    });

    it('keeps site isolation in effect for the mobile view', async () => {
        verifyAccessMock.mockResolvedValue(false);

        const response = await GET(new Request('https://example.test/api/site-live-data?siteId=site-b&view=mobile'));

        expect(response.status).toBe(401);
        expect(siteMock).not.toHaveBeenCalled();
        expect(bucketedMock).not.toHaveBeenCalled();
        expect(refreshTodayMock).not.toHaveBeenCalled();
    });

    it('preserves the existing web fields and adds source freshness fields', async () => {
        const response = await GET(new Request('https://example.test/api/site-live-data?siteId=site-a'));
        const body = await response.json();

        expect(body.percentageCharged).toBe(73);
        expect(body.stateOfCharge).toBeNull();
        expect(body.sourceTimestamps.liveStatusAt).toBeTruthy();
        expect(body.sourceTimestamps.energyDataThrough).toBeNull();
    });

    it('reports the newest bucket sample time instead of its 15-minute bucket start', async () => {
        const sampleTimestamp = new Date(Date.now() - 2 * 60 * 1000);
        const bucketStart = new Date(Math.floor(sampleTimestamp.getTime() / (15 * 60 * 1000)) * (15 * 60 * 1000));
        bucketedMock.mockResolvedValue([{
            timestamp: bucketStart, sample_timestamp: sampleTimestamp,
            site_id: 'site-a', tariff_id: 1, tariff_schedule_id: 3,
            load_power: 900, solar_power: 1200, grid_power: 200, battery_power: -100,
            battery_soc: null, sample_count: 1,
        }]);

        const response = await GET(new Request('https://example.test/api/site-live-data?siteId=site-a&view=mobile'));
        const body = await response.json();

        expect(body.sources.energyDataThrough).toBe(sampleTimestamp.toISOString());
        expect(body.sources.energyDataThrough).not.toBe(bucketStart.toISOString());
    });

    it('adds only daily tariff pricing for mobile and keeps web queries unchanged', async () => {
        const webResponse = await GET(new Request('https://example.test/api/site-live-data?siteId=site-a'));
        expect(webResponse.status).toBe(200);
        expect(usageMock).toHaveBeenCalledTimes(1);
        expect(rawMock).not.toHaveBeenCalled();

        clearCycleRollupCache();
        bucketedMock.mockClear();
        usageMock.mockClear();
        rawMock.mockClear();
        const mobileResponse = await GET(new Request('https://example.test/api/site-live-data?siteId=site-a&view=mobile'));
        expect(mobileResponse.status).toBe(200);
        expect(usageMock).toHaveBeenCalledTimes(2);
        expect(bucketedMock).toHaveBeenCalledTimes(1);
        expect(rawMock).not.toHaveBeenCalled();
    });

});
