import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { verifyAccessMock, refreshMock, refreshTodayMock, siteMock, bucketedMock, usageMock, rawMock, latestSocMock, historyRevisionMock, importStatusMock } = vi.hoisted(() => ({
    verifyAccessMock: vi.fn(),
    refreshMock: vi.fn(),
    refreshTodayMock: vi.fn(),
    siteMock: vi.fn(),
    bucketedMock: vi.fn(),
    usageMock: vi.fn(),
    rawMock: vi.fn(),
    latestSocMock: vi.fn(),
    historyRevisionMock: vi.fn(),
    importStatusMock: vi.fn(),
}));

vi.mock('@/lib/auth-checks', () => ({ verifySiteAccess: verifyAccessMock }));
vi.mock('@/lib/today-refresh', () => ({ refreshLiveStatus: refreshMock, refreshTodayData: refreshTodayMock }));
vi.mock('@/lib/site-repo', () => ({
    SiteRepo: class {
        getSite = siteMock;
        getImportStatus = importStatusMock;
        getSiteCurrencyCode = async () => 'EUR';
    },
}));
vi.mock('@/lib/mobile-bill-revision', () => ({
    readMobileBillConfiguration: async () => ({ currency: 'EUR' }),
    readCurrentMobileSite: async (repo: { getSite: (id: string) => Promise<unknown> }, id: string) => ({
        site: await repo.getSite(id), config: { currency: 'EUR' },
    }),
}));
vi.mock('@/lib/mobile-history-revision', () => ({ readMobileHistoryRevision: historyRevisionMock }));
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
        rawMock.mockResolvedValue([]);
        usageMock.mockResolvedValue([]);
        refreshTodayMock.mockResolvedValue({ status: 'no-new-rows' });
        latestSocMock.mockResolvedValue(null);
        historyRevisionMock.mockResolvedValue({ revision: 'r1', priorRevision: 'prior1', latest: null, hasFutureSamples: false });
        importStatusMock.mockResolvedValue({ isImporting: false, lastImportAt: 0 });
    });

    it('limits mobile summary history to the site-local day instead of the sparkline scale window', async () => {
        await GET(new Request('https://example.test/api/site-live-data?siteId=site-a&view=mobile'));
        expect(bucketedMock).toHaveBeenCalledWith('site-a', new Date('2026-09-24T00:00:00Z'), new Date(), []);
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
        expect(usageMock).toHaveBeenCalledWith('site-a', new Date('2026-09-24T00:00:00Z'), new Date(), []);
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

    it('returns the compact mobile contract with last-known SoC from one today read', async () => {
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
        expect(rawMock).toHaveBeenCalledTimes(1);
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
        expect(rawMock).toHaveBeenCalledTimes(1);
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
        historyRevisionMock.mockResolvedValueOnce({ revision: 'r1', latest: oldSample, hasFutureSamples: false })
            .mockResolvedValue({ revision: 'r2', latest: newSample, hasFutureSamples: false });
        bucketedMock.mockResolvedValue([row(oldSample), row(newSample)]);
        refreshTodayMock.mockResolvedValue({ status: 'persisted', rowsPersisted: 1 });

        const response = await GET(new Request('https://example.test/api/site-live-data?siteId=site-a&view=mobile'));
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(refreshTodayMock).toHaveBeenCalledWith('site-a', { minIntervalMs: 5 * 60 * 1000 });
        expect(bucketedMock).toHaveBeenCalledTimes(1);
        expect(body.historyRefresh).toEqual({ status: 'changed' });
        expect(body.sources.energyDataThrough).toBe(newSample.toISOString());
    });

    const recentEnergyRow = () => {
        const sample = new Date(Date.now() - 5 * 60 * 1000);
        return {
            timestamp: sample, sample_timestamp: sample,
            site_id: 'site-a', tariff_id: 1, tariff_schedule_id: 3,
            load_power: 900, solar_power: 1200, grid_power: 200, battery_power: -100,
            battery_soc: null, sample_count: 1,
        };
    };

    it('forces only the history import on pull-to-refresh, inside the client timeout', async () => {
        bucketedMock.mockResolvedValue([recentEnergyRow()]);

        const response = await GET(new Request('https://example.test/api/site-live-data?siteId=site-a&view=mobile&refresh=1'));

        expect(response.status).toBe(200);
        // live-power has just fetched this reading; the 60-second cache must serve it.
        expect(refreshMock).toHaveBeenCalledWith('site-a', { cacheTtlMs: 60 * 1000 });
        expect(refreshTodayMock).toHaveBeenCalledWith('site-a', { force: true, timeoutMs: 10_000 });
    });

    it('has no force=1 alias for refresh=1', async () => {
        const sample = recentEnergyRow();
        bucketedMock.mockResolvedValue([sample]);
        historyRevisionMock.mockResolvedValue({ revision: 'r1', latest: sample.sample_timestamp, hasFutureSamples: false });

        await GET(new Request('https://example.test/api/site-live-data?siteId=site-a&view=mobile&force=1'));

        expect(refreshTodayMock).not.toHaveBeenCalled();
    });

    it('keeps the state of charge of a reading fetched after the request started', async () => {
        refreshMock.mockImplementation(async () => {
            vi.setSystemTime(Date.now() + 1500);
            return {
                status: 'refreshed', liveStatus: {
                    solar_power: 1200, load_power: 900, battery_power: -100, grid_power: 200,
                    percentage_charged: 73, timestamp: new Date().toISOString(),
                },
            };
        });
        latestSocMock.mockResolvedValue({ value: 40, timestamp: new Date(Date.now() - 30 * 60 * 1000) });

        const response = await GET(new Request('https://example.test/api/site-live-data?siteId=site-a&view=mobile'));

        expect((await response.json()).stateOfCharge).toBe(73);
        expect(latestSocMock).not.toHaveBeenCalled();
    });

    it('does not refresh Tesla history when the mobile energy sample is recent', async () => {
        const sample = new Date(Date.now() - 5 * 60 * 1000);
        historyRevisionMock.mockResolvedValue({ revision: 'r1', latest: sample, hasFutureSamples: false });
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

    it.each([
        ['in-flight', 'pending'],
        ['throttled', 'throttled'],
        ['no-new-rows', 'overdue'],
        ['error', 'failed'],
    ])('reports %s to a client opening without stored energy', async (result, status) => {
        refreshTodayMock.mockResolvedValue({ status: result });
        const response = await GET(new Request('https://example.test/api/site-live-data?siteId=site-a&view=mobile'));
        expect(response.status).toBe(200);
        expect((await response.json()).historyRefresh).toEqual({ status });
    });

    it('expects an empty day only during the first hour after site midnight', async () => {
        vi.setSystemTime(new Date('2026-09-24T00:30:00.000Z'));
        const early = await GET(new Request('https://example.test/api/site-live-data?siteId=site-a&view=mobile'));
        expect((await early.json()).historyRefresh).toEqual({ status: 'awaiting-data' });

        vi.setSystemTime(new Date('2026-09-24T01:30:00.000Z'));
        const late = await GET(new Request('https://example.test/api/site-live-data?siteId=site-a&view=mobile'));
        expect((await late.json()).historyRefresh).toEqual({ status: 'overdue' });
    });

    it('reports a followed import as failed when it released without recording success', async () => {
        importStatusMock.mockResolvedValue({ isImporting: false, lastImportAt: Date.now() - 10 * 60 * 1000 });
        const response = await GET(new Request('https://example.test/api/site-live-data?siteId=site-a&view=mobile&historyCheck=1'));
        expect((await response.json()).historyRefresh).toEqual({ status: 'failed' });
        expect(refreshTodayMock).not.toHaveBeenCalled();
    });

    it('does not report failure when the followed import recorded its attempt', async () => {
        importStatusMock.mockResolvedValue({ isImporting: false, lastImportAt: Date.now() - 20 * 1000 });
        const response = await GET(new Request('https://example.test/api/site-live-data?siteId=site-a&view=mobile&historyCheck=1'));
        expect((await response.json()).historyRefresh).toEqual({ status: 'overdue' });
    });

    it('reads the import status before history and history only once on a follow-up', async () => {
        const order: string[] = [];
        importStatusMock.mockImplementation(async () => { order.push('status'); return { isImporting: false, lastImportAt: Date.now() }; });
        historyRevisionMock.mockImplementation(async () => { order.push('history'); return { revision: 'r1', priorRevision: 'p', latest: null, hasFutureSamples: false }; });
        rawMock.mockImplementation(async () => { order.push('detail'); return []; });
        await GET(new Request('https://example.test/api/site-live-data?siteId=site-a&view=mobile&historyCheck=1'));
        expect(order.slice(0, 3)).toEqual(['status', 'history', 'detail']);
    });

    it('keeps a usable summary when the post-import history read fails', async () => {
        refreshTodayMock.mockResolvedValue({ status: 'persisted', rowsPersisted: 12 });
        historyRevisionMock.mockReset();
        historyRevisionMock
            .mockResolvedValueOnce({ revision: 'r1', priorRevision: 'p', latest: null, hasFutureSamples: false })
            .mockRejectedValue(new Error('pooler timeout'));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const response = await GET(new Request('https://example.test/api/site-live-data?siteId=site-a&view=mobile'));
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.historyRefresh).toEqual({ status: 'changed' });
        expect(body.historyRevision).toBeUndefined();
        warn.mockRestore();
    });

    it('keeps a usable summary without a revision when the stability read fails', async () => {
        historyRevisionMock.mockReset();
        historyRevisionMock
            .mockResolvedValueOnce({ revision: 'r1', priorRevision: 'p', latest: recentEnergyRow().sample_timestamp, hasFutureSamples: false })
            .mockRejectedValue(new Error('pooler timeout'));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const response = await GET(new Request('https://example.test/api/site-live-data?siteId=site-a&view=mobile'));
        expect(response.status).toBe(200);
        expect((await response.json()).historyRevision).toBeUndefined();
        warn.mockRestore();
    });

    it('logs why a mobile history import failed', async () => {
        refreshTodayMock.mockResolvedValue({ status: 'error', errorMessage: 'Tesla history timed out' });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        await GET(new Request('https://example.test/api/site-live-data?siteId=site-a&view=mobile'));
        expect(warn).toHaveBeenCalledWith('mobile.history.checked', expect.objectContaining({
            importResult: 'error', importError: 'Tesla history timed out',
        }));
        warn.mockRestore();
    });

    it('checks a pending import without kicking off another import', async () => {
        importStatusMock.mockResolvedValue({ isImporting: true, lastImportAt: Date.now() });
        const response = await GET(new Request('https://example.test/api/site-live-data?siteId=site-a&view=mobile&historyCheck=1'));
        expect(refreshTodayMock).not.toHaveBeenCalled();
        expect((await response.json()).historyRefresh).toEqual({ status: 'pending' });
    });

    it('returns an unchanged mobile summary without reading history details', async () => {
        const sample = recentEnergyRow();
        historyRevisionMock.mockResolvedValue({ revision: 'r1', latest: sample.sample_timestamp, hasFutureSamples: false });
        bucketedMock.mockResolvedValue([sample]);
        const url = 'https://example.test/api/site-live-data?siteId=site-a&view=mobile';
        const first = await GET(new Request(url));
        const { historyRevision } = await first.json();
        expect(historyRevision).toEqual(expect.any(String));

        bucketedMock.mockClear();
        rawMock.mockClear();
        usageMock.mockClear();
        const repeat = await GET(new Request(`${url}&knownHistoryRevision=${historyRevision}&refresh=1`));
        expect(repeat.status).toBe(304);
        expect(repeat.headers.get('X-PWUsage-History-Refresh')).toBe('current');
        expect(refreshTodayMock).toHaveBeenLastCalledWith('site-a', { force: true, timeoutMs: 10_000 });
        expect(bucketedMock).not.toHaveBeenCalled();
        expect(rawMock).not.toHaveBeenCalled();
        expect(usageMock).not.toHaveBeenCalled();
    });

    it('does not issue a reusable revision for a summary missing pricing after a failure', async () => {
        usageMock.mockRejectedValue(new Error('pricing unavailable'));
        const response = await GET(new Request('https://example.test/api/site-live-data?siteId=site-a&view=mobile'));
        expect(response.status).toBe(200);
        expect((await response.json()).historyRevision).toBeUndefined();
    });

    it('does not reuse a summary after a same-time history correction', async () => {
        const sample = recentEnergyRow();
        historyRevisionMock.mockResolvedValue({ revision: 'r1', latest: sample.sample_timestamp, hasFutureSamples: false });
        const url = 'https://example.test/api/site-live-data?siteId=site-a&view=mobile';
        const { historyRevision } = await (await GET(new Request(url))).json();

        historyRevisionMock.mockResolvedValue({ revision: 'r2', latest: sample.sample_timestamp, hasFutureSamples: false });
        const response = await GET(new Request(`${url}&knownHistoryRevision=${historyRevision}`));
        expect(response.status).toBe(200);
        expect((await response.json()).historyRevision).not.toBe(historyRevision);
    });

    it('does not issue a reusable revision if history changes during calculation', async () => {
        const sample = recentEnergyRow();
        historyRevisionMock.mockResolvedValueOnce({ revision: 'r1', latest: sample.sample_timestamp, hasFutureSamples: false })
            .mockResolvedValue({ revision: 'r2', latest: sample.sample_timestamp, hasFutureSamples: false });
        const response = await GET(new Request('https://example.test/api/site-live-data?siteId=site-a&view=mobile'));
        expect(response.status).toBe(200);
        expect((await response.json()).historyRevision).toBeUndefined();
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

    it('reuses one today detail read for mobile pricing and keeps web queries unchanged', async () => {
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
        expect(rawMock).toHaveBeenCalledTimes(1);
        expect(usageMock).toHaveBeenLastCalledWith('site-a', new Date('2026-09-24T00:00:00Z'), new Date(), []);
    });

});
