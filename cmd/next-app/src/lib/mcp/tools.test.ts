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
            utility: 'PG&E ',
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

    it('get_live_status names battery and grid direction instead of exposing Tesla signs', async () => {
        // Tesla live status: battery_power > 0 discharges, grid_power > 0 imports.
        // Stored history uses the opposite battery sign, so the tool never ships a signed value.
        const live = (battery_power: number, grid_power: number) => ({
            status: 'refreshed',
            fetchedAt: Date.parse('2026-11-25T18:33:45Z'),
            liveStatus: { solar_power: 2172, load_power: 751, grid_power, battery_power, percentage_charged: 96, grid_status: 'Active', storm_mode_active: false },
        });

        mockRefreshLiveStatus.mockResolvedValueOnce(live(-1010, -411));
        const charging = JSON.parse((await handleGetLiveStatus(singleHomeCtx, {})).content[0].text);
        expect(charging).toMatchObject({ batteryChargingW: 1010, batteryDischargingW: 0, gridImportW: 0, gridExportW: 411 });

        mockRefreshLiveStatus.mockResolvedValueOnce(live(2500, 300));
        const discharging = JSON.parse((await handleGetLiveStatus(singleHomeCtx, {})).content[0].text);
        expect(discharging).toMatchObject({ batteryChargingW: 0, batteryDischargingW: 2500, gridImportW: 300, gridExportW: 0 });

        for (const payload of [charging, discharging]) {
            expect(payload).not.toHaveProperty('batteryPowerW');
            expect(payload).not.toHaveProperty('gridPowerW');
            // Tesla's live status never carries backup_capable, so the field was always null.
            expect(payload).not.toHaveProperty('backupCapable');
        }
    });

    it('get_current_bill reads the bill without the outlook or the Smart Shift timeline', async () => {
        mockGetSite.mockResolvedValue({
            id: 'site-1', name: 'Main Home', timezone: 'America/Chicago',
            billing_start_day: 11, billing_start_day_confirmed_at: '2026-01-01T00:00:00Z', tariffs: [{ id: 1 }],
        });
        mockReadCurrentBilling.mockResolvedValue({
            status: 'current',
            summary: {
                site: { id: 'site-1', name: 'Main Home', timezone: 'America/Chicago' },
                currentBill: { status: 'complete', estimatedCost: 34.17, currency: 'USD', cycleStart: '2026-11-11T06:00:00.000Z', cycleEnd: '2026-12-11T06:00:00.000Z', periods: [] },
                loadTiming: null,
                sources: { energyDataThrough: '2026-11-25T17:55:00Z' },
            },
        });

        const payload = JSON.parse((await handleGetCurrentBill(singleHomeCtx, {})).content[0].text);
        // Same read the billing integration makes (integrations/v1/billing).
        expect(mockReadCurrentBilling).toHaveBeenCalledWith('site-1', { refreshStale: true, includeLoadTimingTimeline: false });
        expect(payload.currentBill.estimatedCost).toBe(34.17);
        expect(payload.loadTiming).toBeNull();
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
                loadTiming: null,
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
        expect(emptyPayload.days).toHaveLength(8);
        expect(emptyPayload.days.every((d: { status: string }) => d.status === 'missing')).toBe(true);
        expect(mockPoolQuery).toHaveBeenCalledWith(
            expect.stringContaining('AT TIME ZONE $4'),
            ['site-1', '2026-11-18', '2026-11-25', 'America/Los_Angeles'],
        );
    });

    it('get_daily_usage converts summary Wh sums to kWh for every field, load and solar included', async () => {
        mockGetSite.mockResolvedValue({ id: 'site-1', name: 'Main Home', timezone: 'America/Chicago' });
        // EnergyDaySummary stores every column as Wh summed over samples (rollupDay),
        // so load and solar convert exactly like the grid and battery columns.
        mockPoolQuery.mockResolvedValueOnce({
            rows: [{
                day: '2026-11-16',
                load_wh: 81_216.4,
                solar_wh: 20_832.6,
                grid_import_wh: 61_522,
                grid_export_wh: 52,
                battery_charge_wh: 10_778,
                battery_discharge_wh: 9_690,
                status: 'complete',
                sample_count: 288,
                expected_slots: 288,
            }],
        });

        const res = await handleGetDailyUsage(singleHomeCtx, { from_date: '2026-11-16', to_date: '2026-11-16' });
        const payload = JSON.parse(res.content[0].text);
        expect(payload.days).toEqual([{
            date: '2026-11-16',
            status: 'complete',
            sampleCount: 288,
            expectedSamples: 288,
            loadKwh: 81.216,
            solarKwh: 20.833,
            gridImportKwh: 61.522,
            gridExportKwh: 0.052,
            batteryChargeKwh: 10.778,
            batteryDischargeKwh: 9.69,
        }]);
        // The day balances: load = solar + import - export + discharge - charge.
        const day = payload.days[0];
        expect(day.solarKwh + day.gridImportKwh - day.gridExportKwh + day.batteryDischargeKwh - day.batteryChargeKwh)
            .toBeCloseTo(day.loadKwh, 1);
    });

    it('get_daily_usage reports every requested day with its record status', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-11-25T18:00:00Z')); // noon in Chicago
        try {
            mockGetSite.mockResolvedValue({ id: 'site-1', name: 'Main Home', timezone: 'America/Chicago' });
            const row = (day: string, status: string | null, sample_count: number, wh: number | null) => ({
                day, status, sample_count, expected_slots: 288,
                load_wh: wh, solar_wh: wh, grid_import_wh: wh, grid_export_wh: wh, battery_charge_wh: wh, battery_discharge_wh: wh,
            });
            mockPoolQuery.mockResolvedValueOnce({
                rows: [
                    row('2026-11-19', 'complete', 288, 1000),
                    row('2026-11-20', 'gapped', 250, 1000),
                    // 11-21 has no record at all.
                    row('2026-11-22', 'empty', 0, null),
                    row('2026-11-23', null, 288, 1000), // v1 record: no stored status
                    row('2026-11-24', null, 200, 1000),
                    row('2026-11-25', 'open', 144, 500),
                ],
            });

            const res = await handleGetDailyUsage(singleHomeCtx, { from_date: '2026-11-19', to_date: '2026-11-27' });
            const days: Array<Record<string, unknown>> = JSON.parse(res.content[0].text).days;

            // Future dates are not listed; every past or current date is, record or not.
            expect(days.map(d => [d.date, d.status, d.sampleCount, d.expectedSamples])).toEqual([
                ['2026-11-19', 'complete', 288, 288],
                ['2026-11-20', 'gapped', 250, 288],
                ['2026-11-21', 'missing', 0, null],
                ['2026-11-22', 'no_data', 0, 288],
                ['2026-11-23', 'complete', 288, 288],
                ['2026-11-24', 'partial', 200, 288],
                ['2026-11-25', 'partial', 144, 288],
            ]);
            // Totals only where samples exist.
            expect(days[0].loadKwh).toBe(1);
            expect(days[2].loadKwh).toBeNull();
            expect(days[3].loadKwh).toBeNull();
            expect(days[6].loadKwh).toBe(0.5);
        } finally {
            vi.useRealTimers();
        }
    });
});
