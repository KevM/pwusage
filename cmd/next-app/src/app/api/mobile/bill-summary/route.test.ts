import { beforeEach, describe, expect, it, vi } from 'vitest';

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

describe('mobile bill summary route', () => {
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
});
