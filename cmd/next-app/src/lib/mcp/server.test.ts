import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { OAuthAccessContext } from '@/lib/oauth/types';

const mockGetSite = vi.fn();
const mockGetSitesByIds = vi.fn();
const mockRefreshLiveStatus = vi.fn();
const mockReadCurrentBilling = vi.fn();
const mockPoolQuery = vi.fn();

vi.mock('@/lib/site-repo', () => ({
    SiteRepo: class {
        getSite(...args: unknown[]) { return mockGetSite(...args); }
        getSitesByIds(...args: unknown[]) { return mockGetSitesByIds(...args); }
    },
}));
vi.mock('@/lib/today-refresh', () => ({ refreshLiveStatus: (...args: unknown[]) => mockRefreshLiveStatus(...args) }));
vi.mock('@/lib/current-billing-service', () => ({ readCurrentBilling: (...args: unknown[]) => mockReadCurrentBilling(...args) }));
vi.mock('@/lib/db', () => ({ pool: { query: (...args: unknown[]) => mockPoolQuery(...args) } }));
vi.mock('@/lib/observability', () => ({ logEvent: vi.fn() }));

import { createPwusageMcpServer } from './server';

const ctx: OAuthAccessContext = {
    grantId: 'grant-1',
    userId: 'user-1',
    clientId: 'pwu_client_1',
    clientName: 'Claude',
    scopes: ['billing:read', 'usage:read'],
    authorizedSiteIds: ['site-1'],
};

const site = {
    id: 'site-1', name: 'Harrison', utility: 'We energies ', timezone: 'America/Chicago',
    billing_start_day: 11, billing_start_day_confirmed_at: '2026-01-01T00:00:00Z', tariffs: [{ id: 1 }],
};

const period = (name: string, isActive: boolean) => ({
    name, marginalCost: 0.1, basis: 'buy', cycleNetExportKwh: -344.6, isActive,
    nextStartPhrase: isActive ? null : 'today at 8 PM', buyRate: 0.10279, sellRate: 0.03289,
});
const segment = { start: '2026-11-25T18:00:00.000Z', end: '2026-11-26T02:00:00.000Z', periodKey: 'ON_PEAK', name: 'ON_PEAK', buyRate: 0.30335, sellRate: 0.03863 };
const loadTiming = {
    hasTariff: true, hasCycleData: true, activeIsCheapest: true,
    periods: [period('OFF_PEAK', false), period('ON_PEAK', true)],
    pricingPeriods: [period('OFF_PEAK', false), period('ON_PEAK', true)],
    nextCheaper: null, nextCheaperPhrase: null,
    nextStartPhraseByKey: { OFF_PEAK: 'today at 8 PM', ON_PEAK: 'Friday at 8 AM' },
};
const currentBill = {
    status: 'complete', estimatedCost: 34.17, currency: 'USD',
    cycleStart: '2026-11-11T06:00:00.000Z', cycleEnd: '2026-12-11T06:00:00.000Z',
    periods: [{ tariffName: 'Residential TOU', periodName: 'OFF_PEAK', netGridKwh: 344.6, cost: 35.42 }],
};

/** A real MCP client over an in-memory transport: it validates every result against the published outputSchema (Ajv). */
async function connectClient(): Promise<Client> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await createPwusageMcpServer(ctx).connect(serverTransport);
    const client = new Client({ name: 'contract-test', version: '1.0.0' });
    await client.connect(clientTransport);
    // The client caches each tool's outputSchema from tools/list and only validates calls after it.
    await client.listTools();
    return client;
}

describe('MCP output contract', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        process.env.NEXT_PUBLIC_APP_URL = 'https://pwusage.fm.rodeo';
        mockGetSite.mockResolvedValue(site);
        mockRefreshLiveStatus.mockResolvedValue({
            status: 'cached', fetchedAt: Date.parse('2026-11-25T18:33:45Z'),
            liveStatus: {
                solar_power: 2172, load_power: 751, grid_power: -411, battery_power: -1010, percentage_charged: 96.2,
                grid_status: 'Active', storm_mode_active: false, island_status: 'on_grid', generator_power: 0, timestamp: 'x',
            },
        });
        mockReadCurrentBilling.mockImplementation((_siteId: string, options: { includeLoadTimingTimeline?: boolean; includeOutlook?: boolean }) => ({
            status: 'current',
            summary: {
                version: 1,
                site: { id: 'site-1', name: 'Harrison', timezone: 'America/Chicago' },
                currentBill,
                loadTiming: options.includeLoadTimingTimeline === false ? loadTiming : { ...loadTiming, tariffTimeline: [segment] },
                ...(options.includeOutlook ? { outlook: { tariffTimeline: [{ ...segment, tariffName: 'Residential TOU', periodName: 'ON_PEAK' }] } } : {}),
                sources: { calculatedAt: '2026-11-25T18:34:00Z', energyDataThrough: '2026-11-25T18:30:00.000Z' },
            },
        }));
        mockPoolQuery.mockResolvedValue({
            rows: [
                { day: '2026-11-23', status: 'complete', sample_count: 288, expected_slots: 288,
                    load_wh: 23011, solar_wh: 16172, grid_import_wh: 14716, grid_export_wh: 4301, battery_charge_wh: 10654, battery_discharge_wh: 7078 },
                { day: '2026-11-24', status: 'empty', sample_count: 0, expected_slots: 288,
                    load_wh: null, solar_wh: null, grid_import_wh: null, grid_export_wh: null, battery_charge_wh: null, battery_discharge_wh: null },
            ],
        });
    });

    it('publishes an outputSchema for every tool', async () => {
        const client = await connectClient();
        const { tools } = await client.listTools();
        expect(tools.map(tool => tool.name).sort()).toEqual(
            ['get_current_bill', 'get_daily_usage', 'get_live_status', 'get_smart_shift_outlook', 'list_homes'],
        );
        for (const tool of tools) {
            expect(tool.outputSchema, tool.name).toMatchObject({ type: 'object', additionalProperties: false });
        }
    });

    it.each([
        ['list_homes', {}],
        ['get_live_status', {}],
        ['get_current_bill', {}],
        ['get_smart_shift_outlook', {}],
        ['get_daily_usage', { from_date: '2026-11-22', to_date: '2026-11-24' }],
    ])('%s returns structuredContent that passes the client-side schema check', async (name, args) => {
        const client = await connectClient();
        // callTool throws if structuredContent is missing or fails the published schema.
        const result = await client.callTool({ name, arguments: args });
        expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
        expect(result.structuredContent).toBeDefined();
        const text = (result.content as Array<{ type: string; text: string }>)[0].text;
        expect(JSON.parse(text)).toEqual(result.structuredContent);
    });

    it('drops a field the schema does not declare instead of failing strict clients', async () => {
        mockRefreshLiveStatus.mockResolvedValueOnce({
            status: 'cached', fetchedAt: Date.parse('2026-11-25T18:33:45Z'),
            liveStatus: { solar_power: 1, load_power: 1, grid_power: 0, battery_power: 0, percentage_charged: 50, grid_status: 'Active', storm_mode_active: false },
        });
        const client = await connectClient();
        const ok = await client.callTool({ name: 'get_live_status', arguments: {} });
        expect(ok.isError).toBeFalsy();

        // Simulate drift: the bill tool leaking the Smart Shift timeline it no longer declares.
        mockReadCurrentBilling.mockImplementationOnce(() => ({
            status: 'current',
            summary: {
                site: { id: 'site-1', name: 'Harrison', timezone: 'America/Chicago' },
                currentBill,
                loadTiming: { ...loadTiming, tariffTimeline: [segment] },
                sources: { energyDataThrough: null },
            },
        }));
        const result = await client.callTool({ name: 'get_current_bill', arguments: {} });
        expect(result.isError).toBeFalsy();
        const structured = result.structuredContent as { loadTiming: Record<string, unknown> };
        expect(structured.loadTiming).not.toHaveProperty('tariffTimeline');
        expect((result.content as Array<{ text: string }>)[0].text).not.toContain('tariffTimeline');
    });

    it('returns errors as isError text without structuredContent', async () => {
        const client = await connectClient();
        const result = await client.callTool({ name: 'get_daily_usage', arguments: { from_date: '2026-01-01', to_date: '2026-11-24' } });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toBeUndefined();
    });
});
