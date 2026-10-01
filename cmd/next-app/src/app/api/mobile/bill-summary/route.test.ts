import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { verifyAccessMock, siteMock, currencyMock, usageMock, latestMock } = vi.hoisted(() => ({
    verifyAccessMock: vi.fn(), siteMock: vi.fn(), currencyMock: vi.fn(), usageMock: vi.fn(), latestMock: vi.fn(),
}));

vi.mock('@/lib/auth-checks', () => ({ verifySiteAccess: verifyAccessMock }));
vi.mock('@/lib/site-repo', () => ({ SiteRepo: class { getSite = siteMock; getSiteCurrencyCode = currencyMock; } }));
vi.mock('@/lib/energy-repo', () => ({
    EnergyRepo: class { getUsageByTOU = usageMock; getLatestTimestamp = latestMock; },
}));

import { GET } from './route';
import { getCurrentCycleStart, getNextCycleStart } from '@/lib/billing-cycle';

function tariff(name = 'Seasonal utility') {
    return {
        id: 1, site_id: 'site-a', name, updated: new Date('2026-01-01'),
        seasons: [
            {
                id: 2, tariff_id: 1, name: 'Summer', from_month: 6, from_day: 1, to_month: 9, to_day: 30,
                buy_rate: 0.4, sell_rate: 0.05,
                schedules: [
                    { id: 3, season_id: 2, name: 'Peak', buy_rate: 0.4, sell_rate: 0.05, from_day_of_week: 0, to_day_of_week: 6, from_hour: 6, from_minute: 0, to_hour: 20, to_minute: 0 },
                    { id: 4, season_id: 2, name: 'Off peak', buy_rate: 0.1, sell_rate: 0.03, from_day_of_week: 0, to_day_of_week: 6, from_hour: 20, from_minute: 0, to_hour: 6, to_minute: 0 },
                ],
            },
            {
                id: 5, tariff_id: 1, name: 'Winter', from_month: 10, from_day: 1, to_month: 5, to_day: 31,
                buy_rate: 0.8, sell_rate: 0.02,
                schedules: [
                    { id: 6, season_id: 5, name: 'Winter peak', buy_rate: 0.8, sell_rate: 0.02, from_day_of_week: 0, to_day_of_week: 6, from_hour: 0, from_minute: 0, to_hour: 24, to_minute: 0 },
                ],
            },
        ],
    };
}

describe('mobile bill summary route', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    beforeEach(() => {
        vi.clearAllMocks();
        verifyAccessMock.mockResolvedValue(true);
        siteMock.mockResolvedValue({
            id: 'site-a', name: 'Home', timezone: 'America/Los_Angeles', billing_start_day: 15,
            tariffs: [],
        });
        currencyMock.mockResolvedValue('EUR');
        usageMock.mockResolvedValue([
            { cost: 1.2, gridUsage: 6000, tariff: { name: 'Historical utility' }, touName: 'Peak' },
            { cost: -0.1, gridUsage: -2000, tariff: { name: 'Current utility' }, touName: 'Off peak' },
        ]);
        latestMock.mockResolvedValue(new Date('2026-09-19T01:55:00Z'));
    });

    it('uses the canonical billing-cycle aggregator and returns only a compact summary', async () => {
        vi.setSystemTime(new Date('2026-09-19T02:00:00Z'));
        const response = await GET(new Request('https://example.test/api/mobile/bill-summary?siteId=site-a'));
        const body = await response.json();
        const start = getCurrentCycleStart(15, new Date('2026-09-19T02:00:00Z'), 'America/Los_Angeles');
        const end = getNextCycleStart(15, start, 'America/Los_Angeles');

        expect(response.status).toBe(200);
        expect(usageMock).toHaveBeenCalledWith('site-a', start, end);
        expect(usageMock).toHaveBeenCalledTimes(1);
        expect(latestMock).toHaveBeenCalledTimes(1);
        expect(body.currentBill.estimatedCost).toBeCloseTo(1.1);
        expect(body.currentBill.periods).toEqual([
            { tariffName: 'Historical utility', periodName: 'Peak', netGridKwh: 6, cost: 1.2 },
            { tariffName: 'Current utility', periodName: 'Off peak', netGridKwh: -2, cost: -0.1 },
        ]);
        expect(body.currentBill.periods.reduce((sum: number, period: { cost: number }) => sum + period.cost, 0))
            .toBeCloseTo(body.currentBill.estimatedCost);
        expect(body.currentBill).toMatchObject({
            currency: 'EUR', cycleStart: start.toISOString(), cycleEnd: end.toISOString(),
        });
        expect(body.sources.energyDataThrough).toBe('2026-09-19T01:55:00.000Z');
        expect(JSON.stringify(body)).not.toContain('tariff_content_v2');
        expect(JSON.stringify(body)).not.toContain('gridUsage');
        vi.useRealTimers();
    });

    it('does not read site or billing data for an unauthorized site', async () => {
        verifyAccessMock.mockResolvedValue(false);

        const response = await GET(new Request('https://example.test/api/mobile/bill-summary?siteId=site-b'));

        expect(response.status).toBe(401);
        expect(siteMock).not.toHaveBeenCalled();
        expect(usageMock).not.toHaveBeenCalled();
    });

    it('leaves the estimate unknown when the billing aggregation has no rows', async () => {
        usageMock.mockResolvedValue([]);

        const response = await GET(new Request('https://example.test/api/mobile/bill-summary?siteId=site-a'));
        const body = await response.json();

        expect(body.currentBill.estimatedCost).toBeNull();
        expect(body.currentBill.periods).toEqual([]);
    });

    it('returns canonical current-season load timing detail using the existing cycle usage query', async () => {
        vi.setSystemTime(new Date('2026-09-19T02:00:00Z'));
        siteMock.mockResolvedValue({
            id: 'site-a', name: 'Home', timezone: 'America/Los_Angeles', billing_start_day: 15,
            tariffs: [tariff()],
        });
        usageMock.mockResolvedValue([
            { start: new Date('2026-09-18T23:00:00Z'), cost: 2.4, gridUsage: 6000, homeUsage: 0, solarProduction: 0, batteryChange: 0, tariff: tariff(), touName: 'Peak', buyRate: 0.4, sellRate: 0.05 },
        ]);

        const response = await GET(new Request('https://example.test/api/mobile/bill-summary?siteId=site-a'));
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(usageMock).toHaveBeenCalledTimes(1);
        expect(body.loadTiming).toMatchObject({
            hasTariff: true,
            hasCycleData: true,
            activeIsCheapest: true,
            periods: [{ name: 'Peak', marginalCost: 0.4, basis: 'buy', cycleNetExportKwh: -6, isActive: true, buyRate: 0.4, sellRate: 0.05 }],
            pricingPeriods: expect.arrayContaining([
                expect.objectContaining({ name: 'Peak', isActive: true }),
                expect.objectContaining({ name: 'Off peak', marginalCost: 0.1, basis: 'neutral', cycleNetExportKwh: 0, buyRate: 0.1, sellRate: 0.03 }),
            ]),
            nextCheaper: null,
        });
        expect(body.loadTiming.periods[0].nextStartPhrase).toBeNull();
        expect(body.loadTiming.pricingPeriods.find((period: { name: string }) => period.name === 'Off peak').nextStartPhrase).toEqual(expect.any(String));
        expect(body.loadTiming.pricingPeriods).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Winter peak' })]));
        expect(body.loadTiming.tariffTimeline[0]).toMatchObject({
            start: '2026-09-19T01:55:00.000Z',
            end: '2026-09-19T03:00:00.000Z',
            periodKey: 'Peak', name: 'Peak', buyRate: 0.4, sellRate: 0.05,
        });
        expect(body.loadTiming.tariffTimeline.at(-1)?.end).toBe('2026-09-26T02:00:00.000Z');
        expect(body.loadTiming.tariffTimeline[1]).toMatchObject({
            start: '2026-09-19T03:00:00.000Z', periodKey: 'Off peak', name: 'Off peak', buyRate: 0.1, sellRate: 0.03,
        });
        expect(body.sources).toEqual({ calculatedAt: '2026-09-19T02:00:00.000Z', energyDataThrough: '2026-09-19T01:55:00.000Z' });
        expect(siteMock).toHaveBeenCalledTimes(1);
        expect(currencyMock).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(body)).not.toContain('tariff_content_v2');
        expect(JSON.stringify(body)).not.toContain('gridUsage');
        vi.useRealTimers();
    });

    it('clamps the tariff timeline start to the usable freshness window for a stale site', async () => {
        vi.setSystemTime(new Date('2026-09-19T02:00:00Z'));
        siteMock.mockResolvedValue({
            id: 'site-a', name: 'Home', timezone: 'America/Los_Angeles', billing_start_day: 15,
            tariffs: [tariff()],
        });
        usageMock.mockResolvedValue([
            { start: new Date('2026-09-18T23:00:00Z'), cost: 2.4, gridUsage: 6000, homeUsage: 0, solarProduction: 0, batteryChange: 0, tariff: tariff(), touName: 'Peak', buyRate: 0.4, sellRate: 0.05 },
        ]);
        // A site that stopped reporting eight months ago.
        latestMock.mockResolvedValue(new Date('2026-01-19T02:00:00Z'));

        const response = await GET(new Request('https://example.test/api/mobile/bill-summary?siteId=site-a'));
        const body = await response.json();

        expect(response.status).toBe(200);
        // The reported source is still the true last sample; only the walk is
        // bounded, so the app sees the staleness for itself.
        expect(body.sources.energyDataThrough).toBe('2026-01-19T02:00:00.000Z');
        expect(body.loadTiming.tariffTimeline[0].start).toBe('2026-09-19T01:30:00.000Z');
        expect(body.loadTiming.tariffTimeline.at(-1)?.end).toBe('2026-09-26T02:00:00.000Z');
        vi.useRealTimers();
    });

    it('provides explicit unavailable pricing when no tariff or cycle data exists', async () => {
        usageMock.mockResolvedValue([]);

        const response = await GET(new Request('https://example.test/api/mobile/bill-summary?siteId=site-a'));
        const body = await response.json();

        expect(body.loadTiming).toBeNull();
        expect(usageMock).toHaveBeenCalledTimes(1);
    });

    it('does not infer a configured tariff from historical usage alone', async () => {
        usageMock.mockResolvedValue([
            { start: new Date('2026-09-18T23:00:00Z'), cost: 1, gridUsage: 1000, homeUsage: 0, solarProduction: 0, batteryChange: 0, tariff: tariff(), touName: 'Peak', buyRate: 0.4, sellRate: 0.05 },
        ]);

        const response = await GET(new Request('https://example.test/api/mobile/bill-summary?siteId=site-a'));
        const body = await response.json();

        expect(body.loadTiming).toBeNull();
        expect(body.currentBill.periods).toHaveLength(1);
        expect(usageMock).toHaveBeenCalledTimes(1);
    });

    it('includes configured pricing periods when the cycle has no observations', async () => {
        // The configured periods below belong to the summer tariff fixture.
        vi.setSystemTime(new Date('2026-09-19T02:00:00Z'));
        siteMock.mockResolvedValue({
            id: 'site-a', name: 'Home', timezone: 'America/Los_Angeles', billing_start_day: 15,
            tariffs: [tariff()],
        });
        usageMock.mockResolvedValue([]);

        const response = await GET(new Request('https://example.test/api/mobile/bill-summary?siteId=site-a'));
        const body = await response.json();

        expect(body.loadTiming.hasCycleData).toBe(false);
        expect(body.loadTiming.periods).toEqual([]);
        expect(body.loadTiming.pricingPeriods).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: 'Peak', marginalCost: 0.4, basis: 'neutral' }),
            expect.objectContaining({ name: 'Off peak', marginalCost: 0.1, basis: 'neutral' }),
        ]));
        expect(body.loadTiming.nextCheaper).toBeNull();
        expect(usageMock).toHaveBeenCalledTimes(1);
        vi.useRealTimers();
    });

    it('uses required season rates when active schedule overrides are absent', async () => {
        const configured = tariff();
        configured.seasons[0].schedules[0].buy_rate = null;
        configured.seasons[0].schedules[0].sell_rate = null;
        siteMock.mockResolvedValue({
            id: 'site-a', name: 'Home', timezone: 'America/Los_Angeles', billing_start_day: 15,
            tariffs: [configured],
        });
        usageMock.mockResolvedValue([
            { start: new Date('2026-09-18T23:00:00Z'), cost: 2.4, gridUsage: -6000, homeUsage: 0, solarProduction: 0, batteryChange: 0, tariff: configured, touName: 'Peak', buyRate: 0.4, sellRate: 0.05 },
        ]);
        vi.setSystemTime(new Date('2026-09-19T02:00:00Z'));

        const response = await GET(new Request('https://example.test/api/mobile/bill-summary?siteId=site-a'));
        const body = await response.json();

        expect(body.loadTiming.periods).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: 'Peak', marginalCost: 0.05, basis: 'sell', buyRate: 0.4, sellRate: 0.05 }),
        ]));
        expect(body.loadTiming.pricingPeriods).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: 'Off peak', marginalCost: 0.1, buyRate: 0.1, sellRate: 0.03 }),
        ]));
        expect(body.loadTiming.periods[0].buyRate).not.toBe(0);
        vi.useRealTimers();
    });

    it('returns unknown detail when malformed tariff data has no resolvable season rates', async () => {
        const configured = tariff();
        configured.seasons[0].buy_rate = null as unknown as number;
        configured.seasons[0].sell_rate = null as unknown as number;
        configured.seasons[0].schedules[0].buy_rate = null;
        configured.seasons[0].schedules[0].sell_rate = null;
        siteMock.mockResolvedValue({
            id: 'site-a', name: 'Home', timezone: 'America/Los_Angeles', billing_start_day: 15,
            tariffs: [configured],
        });
        usageMock.mockResolvedValue([
            { start: new Date('2026-09-18T23:00:00Z'), cost: 2.4, gridUsage: 6000, homeUsage: 0, solarProduction: 0, batteryChange: 0, tariff: configured, touName: 'Peak', buyRate: undefined, sellRate: undefined },
        ]);
        vi.setSystemTime(new Date('2026-09-19T02:00:00Z'));

        const response = await GET(new Request('https://example.test/api/mobile/bill-summary?siteId=site-a'));
        const body = await response.json();

        expect(body.loadTiming).toBeNull();
        vi.useRealTimers();
    });

    it('returns unknown detail when another current-season period has no effective rates', async () => {
        const configured = tariff();
        configured.seasons[0].schedules[1].buy_rate = null;
        configured.seasons[0].schedules[1].sell_rate = null;
        configured.seasons[0].buy_rate = null as unknown as number;
        configured.seasons[0].sell_rate = null as unknown as number;
        siteMock.mockResolvedValue({
            id: 'site-a', name: 'Home', timezone: 'America/Los_Angeles', billing_start_day: 15,
            tariffs: [configured],
        });
        usageMock.mockResolvedValue([
            { start: new Date('2026-09-18T23:00:00Z'), cost: 2.4, gridUsage: 6000, homeUsage: 0, solarProduction: 0, batteryChange: 0, tariff: configured, touName: 'Peak', buyRate: 0.4, sellRate: 0.05 },
        ]);
        vi.setSystemTime(new Date('2026-09-19T02:00:00Z'));

        const response = await GET(new Request('https://example.test/api/mobile/bill-summary?siteId=site-a'));
        const body = await response.json();

        expect(body.loadTiming).toBeNull();
        vi.useRealTimers();
    });

    it('accepts legitimate zero rates for every current-season period', async () => {
        const configured = tariff();
        configured.seasons[0].buy_rate = 0;
        configured.seasons[0].sell_rate = 0;
        for (const period of configured.seasons[0].schedules) {
            period.buy_rate = null;
            period.sell_rate = null;
        }
        siteMock.mockResolvedValue({
            id: 'site-a', name: 'Home', timezone: 'America/Los_Angeles', billing_start_day: 15,
            tariffs: [configured],
        });
        usageMock.mockResolvedValue([
            { start: new Date('2026-09-18T23:00:00Z'), cost: 0, gridUsage: 0, homeUsage: 0, solarProduction: 0, batteryChange: 0, tariff: configured, touName: 'Peak', buyRate: 0, sellRate: 0 },
        ]);
        vi.setSystemTime(new Date('2026-09-19T02:00:00Z'));

        const response = await GET(new Request('https://example.test/api/mobile/bill-summary?siteId=site-a'));
        const body = await response.json();

        expect(body.loadTiming).not.toBeNull();
        expect(body.loadTiming.pricingPeriods).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: 'Off peak', buyRate: 0, sellRate: 0, marginalCost: 0 }),
        ]));
        vi.useRealTimers();
    });

    it('does not include detail data for an unauthorized site', async () => {
        verifyAccessMock.mockResolvedValue(false);

        const response = await GET(new Request('https://example.test/api/mobile/bill-summary?siteId=site-a'));
        const body = await response.json();

        expect(response.status).toBe(401);
        expect(body).not.toHaveProperty('loadTiming');
        expect(usageMock).not.toHaveBeenCalled();
    });
});
