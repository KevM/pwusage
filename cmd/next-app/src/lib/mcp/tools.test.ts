import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OAuthAccessContext } from '@/lib/oauth/types';

const mockGetSitesByIds = vi.fn();
const mockGetSite = vi.fn();
const mockRefreshLiveStatus = vi.fn();
const mockReadCurrentBilling = vi.fn();
const mockPoolQuery = vi.fn();

vi.mock('@/lib/site-repo', () => ({
    SiteRepo: class {
        getSitesByIds(...args: unknown[]) {
            return mockGetSitesByIds(...args);
        }
        getSite(...args: unknown[]) {
            return mockGetSite(...args);
        }
    },
}));

vi.mock('@/lib/today-refresh', () => ({
    refreshLiveStatus: (...args: unknown[]) => mockRefreshLiveStatus(...args),
}));

vi.mock('@/lib/current-billing-service', () => ({
    readCurrentBilling: (...args: unknown[]) => mockReadCurrentBilling(...args),
}));

vi.mock('@/lib/db', () => ({
    pool: {
        query: (...args: unknown[]) => mockPoolQuery(...args),
    },
}));

import {
    handleGetCurrentBill,
    handleGetDailyUsage,
    handleGetLiveStatus,
    handleGetSmartShiftOutlook,
    handleListHomes,
    resolveTargetSiteId,
} from './tools';

const singleHomeCtx: OAuthAccessContext = {
    grantId: 'grant-1',
    userId: 'user-1',
    clientId: 'pwu_client_1',
    clientName: 'Claude',
    scopes: ['billing:read', 'usage:read'],
    authorizedSiteIds: ['site-1'],
};

const multiHomeCtx: OAuthAccessContext = {
    ...singleHomeCtx,
    authorizedSiteIds: ['site-1', 'site-2'],
};

describe('mcp tools', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        process.env.NEXT_PUBLIC_APP_URL = 'https://pwusage.fm.rodeo';
    });

    it('resolveTargetSiteId auto-selects single home, errors on omitted multi-home, and rejects unauthorized site_id', () => {
        expect(resolveTargetSiteId(singleHomeCtx, undefined)).toEqual({ ok: true, siteId: 'site-1' });
        expect(resolveTargetSiteId(multiHomeCtx, undefined)).toEqual({
            ok: false,
            error: 'Multiple homes are authorized. Call list_homes first and pass site_id.',
        });
        expect(resolveTargetSiteId(singleHomeCtx, 'site-999')).toEqual({
            ok: false,
            error: 'site_not_authorized: site-999 is not authorized for this connection.',
        });
    });

    it('enforces billing:read and usage:read scopes', async () => {
        const usageOnlyCtx: OAuthAccessContext = { ...singleHomeCtx, scopes: ['usage:read'] };
        const billingOnlyCtx: OAuthAccessContext = { ...singleHomeCtx, scopes: ['billing:read'] };

        const billRes = await handleGetCurrentBill(usageOnlyCtx, {});
        expect(billRes.isError).toBe(true);

        const outlookRes = await handleGetSmartShiftOutlook(usageOnlyCtx, {});
        expect(outlookRes.isError).toBe(true);

        const liveRes = await handleGetLiveStatus(billingOnlyCtx, {});
        expect(liveRes.isError).toBe(true);

        const dailyRes = await handleGetDailyUsage(billingOnlyCtx, {});
        expect(dailyRes.isError).toBe(true);
    });

    it('list_homes returns authorized homes with setupStatus', async () => {
        mockGetSite.mockResolvedValueOnce({
            id: 'site-1',
            name: 'Main Home',
            utility: 'PG&E',
            timezone: 'America/Los_Angeles',
            billing_start_day: 15,
            billing_start_day_confirmed_at: null,
            tariffs: [],
        });

        const res = await handleListHomes(singleHomeCtx);
        expect(res.isError).toBeFalsy();
        const payload = JSON.parse(res.content[0].text);
        expect(payload.homes).toEqual([
            {
                siteId: 'site-1',
                name: 'Main Home',
                utility: 'PG&E',
                timezone: 'America/Los_Angeles',
                billingStartDay: 15,
                setupStatus: { hasTariff: false, billingDayConfirmed: false },
            },
        ]);
    });

    it('get_live_status returns live power and battery state', async () => {
        mockRefreshLiveStatus.mockResolvedValueOnce({
            status: 'cached',
            fetchedAt: Date.parse('2026-11-25T17:00:00Z'),
            liveStatus: {
                solar_power: 4200,
                load_power: 1800,
                grid_power: -200,
                battery_power: -2200,
                percentage_charged: 82,
                grid_status: 'Active',
                backup_capable: true,
                storm_mode_active: false,
            },
        });

        const res = await handleGetLiveStatus(singleHomeCtx, {});
        expect(res.isError).toBeFalsy();
        const payload = JSON.parse(res.content[0].text);
        expect(payload).toMatchObject({
            siteId: 'site-1',
            solarPowerW: 4200,
            loadPowerW: 1800,
            batterySocPercent: 82,
            gridStatus: 'Active',
        });
    });

    it('get_current_bill and get_smart_shift_outlook include setupNotice when tariff or billing day is unconfirmed', async () => {
        mockGetSite.mockResolvedValue({
            id: 'site-1',
            name: 'Main Home',
            timezone: 'America/Los_Angeles',
            billing_start_day: 1,
            billing_start_day_confirmed_at: null,
            tariffs: [],
        });
        mockReadCurrentBilling.mockResolvedValue({
            status: 'current',
            energyDataThrough: new Date('2026-11-25T16:55:00Z'),
            summary: {
                version: 1,
                site: { id: 'site-1', name: 'Main Home', timezone: 'America/Los_Angeles' },
                currentBill: {
                    status: 'complete',
                    estimatedCost: 42.5,
                    currency: 'USD',
                    cycleStart: '2026-11-01T07:00:00Z',
                    cycleEnd: '2026-12-01T08:00:00Z',
                    periods: [],
                },
                loadTiming: {
                    mode: 'neutral',
                    cycleNetExportKwh: 12.4,
                    headline: 'Standard rate',
                },
                outlook: {
                    cycleNetExportKwh: 12.4,
                    tariffTimeline: [],
                },
                sources: {
                    calculatedAt: '2026-11-25T17:00:00Z',
                    energyDataThrough: '2026-11-25T16:55:00Z',
                },
            },
        });

        const billRes = await handleGetCurrentBill(singleHomeCtx, {});
        const billPayload = JSON.parse(billRes.content[0].text);
        expect(billPayload.setupNotice).toBeDefined();
        expect(billPayload.setupNotice.settingsUrl).toBe('https://pwusage.fm.rodeo/site/site-1/settings');

        const outlookRes = await handleGetSmartShiftOutlook(singleHomeCtx, {});
        const outlookPayload = JSON.parse(outlookRes.content[0].text);
        expect(outlookPayload.setupNotice).toBeDefined();
        expect(outlookPayload.setupNotice.settingsUrl).toBe('https://pwusage.fm.rodeo/site/site-1/settings');
    });

    it('get_daily_usage enforces 31-day cap and returns syncInProgress when no summary rows exist', async () => {
        mockGetSite.mockResolvedValue({
            id: 'site-1',
            name: 'Main Home',
            timezone: 'America/Los_Angeles',
        });

        const overCap = await handleGetDailyUsage(singleHomeCtx, {
            from_date: '2026-10-01',
            to_date: '2026-11-25',
        });
        expect(overCap.isError).toBe(true);

        mockPoolQuery.mockResolvedValueOnce({ rows: [] });
        const emptyRes = await handleGetDailyUsage(singleHomeCtx, {
            from_date: '2026-11-18',
            to_date: '2026-11-25',
        });
        expect(emptyRes.isError).toBeFalsy();
        const emptyPayload = JSON.parse(emptyRes.content[0].text);
        expect(emptyPayload.syncInProgress).toBe(true);
        expect(emptyPayload.days).toEqual([]);
        expect(mockPoolQuery).toHaveBeenCalledWith(
            expect.stringContaining('AT TIME ZONE $4'),
            ['site-1', '2026-11-18', '2026-11-25', 'America/Los_Angeles'],
        );
    });
});
