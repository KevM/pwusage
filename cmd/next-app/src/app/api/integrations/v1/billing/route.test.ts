import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import { IncompleteTariffAttributionError } from '@/lib/billing-availability';
import type { Tariff } from '@/lib/db';
import type { MobileLoadTimingWithTimeline } from '@/lib/mobile-bill-summary';
import type { MobileBillSummary } from '@/lib/mobile-dashboard-contract';

const mocks = vi.hoisted(() => ({
    query: vi.fn(), config: vi.fn(), site: vi.fn(), latest: vi.fn(), usage: vi.fn(), history: vi.fn(),
    refresh: vi.fn(), user: vi.fn(), siteIds: vi.fn(), log: vi.fn(), setLogContext: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ pool: { query: mocks.query } }));
vi.mock('@/lib/site-repo', () => ({
    SiteRepo: class {
        getSite = mocks.site;
        getSiteCurrencyCode = async () => 'USD';
        invalidateCache = vi.fn();
    },
}));
vi.mock('@/lib/energy-repo-factory', () => ({
    createEnergyRepo: () => ({ getLatestTimestamp: mocks.latest, getUsageByTOU: mocks.usage }),
}));
vi.mock('@/lib/mobile-history-revision', () => ({ readMobileHistoryRevision: mocks.history }));
vi.mock('@/lib/tariff-reattribution', () => ({ getSiteReattributionStatus: async () => null }));
vi.mock('@/lib/today-refresh', () => ({ refreshTodayData: mocks.refresh }));
vi.mock('@/lib/auth-checks', () => ({
    verifySiteAccess: async () => true, getAuthorizedSiteIds: mocks.siteIds, getCurrentUser: mocks.user,
}));
vi.mock('@/lib/observability', () => ({
    logEvent: mocks.log, setLogContext: mocks.setLogContext,
    observeRoute: (_route: string, handle: (request: Request) => Promise<Response>) => handle,
}));

import { GET } from './route';
import { GET as getMobileBill } from '@/app/api/mobile/bill-summary/route';
import {
    GET as listTokens, POST as createToken, DELETE as revokeToken,
} from '@/app/api/site/[id]/billing-integrations/route';

const token = 'pwu_int_' + 'a'.repeat(43);
const id = '87ed8088-70f1-482c-86ce-c4ef67106e8d';
const now = new Date('2026-09-19T12:30:00Z');
const current = new Date('2026-09-19T12:25:00Z');
const stale = new Date('2026-09-19T11:25:00Z');
const url = 'https://example.test/api/integrations/v1/billing?siteId=another-home';
const settingsUrl = 'https://example.test/api/site/home/billing-integrations';
const context = { params: Promise.resolve({ id: 'home' }) };

function poll(etag?: string, authorization = `Bearer ${token}`) {
    const headers = new Headers({ Authorization: authorization });
    if (etag) headers.set('If-None-Match', etag);
    return GET(new Request(url, { headers }));
}

beforeEach(() => {
    vi.resetAllMocks();
    vi.setSystemTime(now);
    const config = { name: 'Home', timezone: 'UTC', billing_start_day: 1, currency: 'USD', tariff_ids: [] };
    mocks.site.mockResolvedValue({ ...config, id: 'home', tariffs: [] });
    mocks.config.mockResolvedValue({ rows: [config] });
    mocks.latest.mockResolvedValue(current);
    mocks.history.mockResolvedValue({ latest: current, revision: 'stored-samples', hasFutureSamples: false });
    mocks.usage.mockResolvedValue([
        { cost: -0.1, gridUsage: -2000, tariff: { name: 'Utility' }, touName: 'Peak' },
    ]);
    mocks.user.mockResolvedValue({ id: 'owner' });
    mocks.siteIds.mockResolvedValue(['home']);
    mocks.refresh.mockResolvedValue({ status: 'no-new-rows' });
    mocks.query.mockImplementation((sql: string) => sql.includes('c.token_hash')
        ? { rows: [{ siteId: 'home', id, allowed: true }] }
        : mocks.config(sql));
});

afterEach(() => vi.useRealTimers());

describe('billing integration', () => {
    it('returns the same bill fields and current period banks without the app’s forward schedule', async () => {
        const tariff: Tariff = {
            id: 1, site_id: 'home', name: 'Utility', updated: now,
            seasons: [{
                id: 2, tariff_id: 1, name: 'All year', from_month: 1, from_day: 1, to_month: 12, to_day: 31,
                buy_rate: 0.3, sell_rate: 0.05,
                schedules: [
                    { id: 3, season_id: 2, name: 'Peak', buy_rate: 0.3, sell_rate: 0.05,
                        from_day_of_week: 0, to_day_of_week: 6, from_hour: 6, from_minute: 0, to_hour: 20, to_minute: 0 },
                    { id: 4, season_id: 2, name: 'Off peak', buy_rate: 0.15, sell_rate: 0.04,
                        from_day_of_week: 0, to_day_of_week: 6, from_hour: 20, from_minute: 0, to_hour: 6, to_minute: 0 },
                ],
            }],
        };
        const config = { name: 'Home', timezone: 'UTC', billing_start_day: 1, currency: 'USD', tariff_ids: [tariff.id] };
        mocks.site.mockResolvedValue({ ...config, id: 'home', tariffs: [tariff] });
        mocks.config.mockResolvedValue({ rows: [config] });
        mocks.usage.mockResolvedValue([
            { cost: -0.1, gridUsage: -2000, tariff, touName: 'Peak', buyRate: 0.3, sellRate: 0.05 },
        ]);

        const integrated = await poll();
        const mobile = await getMobileBill(new Request('https://example.test/api/mobile/bill-summary?siteId=home'));
        expect(integrated.status).toBe(200);
        const appBill = await mobile.json() as MobileBillSummary & { loadTiming: MobileLoadTimingWithTimeline };
        const { tariffTimeline, ...periodBalances } = appBill.loadTiming;
        expect(tariffTimeline.length).toBeGreaterThan(1);
        expect(periodBalances.periods).toEqual([
            expect.objectContaining({ name: 'Peak', isActive: true, cycleNetExportKwh: 2, buyRate: 0.3, sellRate: 0.05 }),
        ]);
        expect(await integrated.json()).toEqual({ ...appBill, loadTiming: periodBalances });
        expect(mocks.site).toHaveBeenCalledWith('home');
        expect(mocks.site).not.toHaveBeenCalledWith('another-home');
        expect(mocks.refresh).not.toHaveBeenCalled();
        expect(mocks.setLogContext).toHaveBeenCalledWith({ siteId: 'home', integrationId: id });
        const matchingDigest = createHash('sha256').update(token).digest();
        expect(mocks.query.mock.calls[0][1]).toEqual([matchingDigest, 'billing:read']);
    });

    it('returns an empty 304 for a matching ETag without recalculating the bill', async () => {
        const initial = await poll();
        const etag = initial.headers.get('ETag');
        expect(etag).toMatch(/^W\/"bill-v1-compact-/);
        const repeated = await poll(`"an-old-tag", ${etag?.slice(2)}`);
        expect(repeated.status).toBe(304);
        expect(await repeated.text()).toBe('');
        expect(repeated.headers.get('ETag')).toBe(etag);
        expect(repeated.headers.get('Vary')).toBe('Authorization');
        expect(mocks.usage).toHaveBeenCalledTimes(1);
        expect((await poll(etag?.replace('bill-v1-compact-', 'bill-v1-'))).status).toBe(200);
    });

    it('refreshes a stale bill before comparing the ETag and returns any new sample', async () => {
        mocks.latest.mockResolvedValue(stale);
        mocks.history.mockResolvedValue({ latest: stale, revision: 'old-samples', hasFutureSamples: false });
        const initial = await poll();
        const etag = initial.headers.get('ETag') ?? undefined;
        expect((await initial.json()).sources.energyDataThrough).toBe(stale.toISOString());

        mocks.refresh.mockImplementation(async () => {
            mocks.latest.mockResolvedValue(current);
            mocks.history.mockResolvedValue({ latest: current, revision: 'new-samples', hasFutureSamples: false });
            return { status: 'persisted' };
        });
        const refreshed = await poll(etag);
        expect(refreshed.status).toBe(200);
        expect(refreshed.headers.get('ETag')).not.toBe(etag);
        expect((await refreshed.json()).sources.energyDataThrough).toBe(current.toISOString());
        expect(mocks.refresh).toHaveBeenCalledTimes(2);
        expect(mocks.log).toHaveBeenCalledWith('info', 'integration.billing.refresh', {
            status: 'persisted', ageMs: 65 * 60_000,
        });
    });

    it('refreshes when data is missing and allows reuse when data stays unavailable', async () => {
        mocks.latest.mockResolvedValue(null);
        mocks.history.mockResolvedValue({ latest: null, revision: 'empty', hasFutureSamples: false });
        mocks.usage.mockRejectedValue(new IncompleteTariffAttributionError());

        const initial = await poll();
        expect(await initial.json()).toMatchObject({
            currentBill: { status: 'incomplete-attribution', periods: [] },
            sources: { energyDataThrough: null },
        });
        vi.setSystemTime(new Date(+now + 1000));
        const unmatchedRefresh = await poll(initial.headers.get('ETag') ?? undefined);
        expect(unmatchedRefresh.status).toBe(304);
        expect(mocks.refresh).toHaveBeenCalledTimes(2);
    });

    it('requires the billing grant on an otherwise valid credential', async () => {
        mocks.query.mockResolvedValueOnce({ rows: [{ siteId: 'home', id, allowed: false }] });

        expect((await poll('*')).status).toBe(403);
        expect(mocks.query.mock.calls[0][0]).toContain('FROM "IntegrationGrant"');
        expect(mocks.query.mock.calls[0][1][1]).toBe('billing:read');
        expect(mocks.latest).not.toHaveBeenCalled();
        expect(mocks.refresh).not.toHaveBeenCalled();
    });

    it('authenticates before revalidating or refreshing', async () => {
        expect((await poll('*', 'invalid')).status).toBe(401);
        expect(mocks.query).not.toHaveBeenCalled();
        mocks.query.mockResolvedValueOnce({ rows: [] });
        const revoked = await poll('*');
        expect(revoked.status).toBe(401);
        expect(revoked.headers.get('www-authenticate')).toBe('Bearer');
        expect(mocks.latest).not.toHaveBeenCalled();
        expect(mocks.refresh).not.toHaveBeenCalled();
    });
});

describe('billing integration settings', () => {
    it('returns the credential once and stores only its digest', async () => {
        mocks.query.mockResolvedValueOnce({ rows: [{ id, name: 'Home Assistant' }] });
        const created = await createToken(new NextRequest(settingsUrl, {
            method: 'POST', body: JSON.stringify({ name: ' Home Assistant ', scope: 'unrequested:read' }),
        }), context);
        expect(created.status).toBe(201);
        expect(created.headers.get('cache-control')).toBe('private, no-store');
        const result: { token: string } = await created.json();
        expect(result.token).toMatch(/^pwu_int_[\w-]{43}$/);
        expect(mocks.query.mock.calls[0][1]).toEqual([
            expect.any(String), 'owner', 'home', 'Home Assistant',
            createHash('sha256').update(result.token).digest(), 'billing:read',
        ]);

        expect(mocks.query.mock.calls[0][0]).toContain('INSERT INTO "IntegrationGrant"');

        mocks.query.mockResolvedValueOnce({ rows: [{ id, name: 'Home Assistant' }] });
        const listed = await listTokens(new NextRequest(settingsUrl), context);
        expect(await listed.json()).toEqual({ credentials: [{ id, name: 'Home Assistant' }] });
        expect(mocks.query.mock.calls[1][0]).not.toContain('token_hash');
    });

    it('scopes revocation to the signed-in issuer and home', async () => {
        mocks.query.mockResolvedValueOnce({ rowCount: 1 });
        const response = await revokeToken(new NextRequest(`${settingsUrl}?id=${id}`, { method: 'DELETE' }), context);
        expect(response.status).toBe(204);
        expect(mocks.query.mock.calls[0][1]).toEqual(['owner', 'home', id, 'billing:read']);
    });

    it('blocks creation from a different origin or for another home', async () => {
        const request = (origin: string) => new NextRequest(settingsUrl, {
            method: 'POST', headers: { Origin: origin }, body: JSON.stringify({ name: 'Test' }),
        });
        expect((await createToken(request('https://other.test'), context)).status).toBe(403);
        mocks.siteIds.mockResolvedValue(['other-home']);
        expect((await createToken(request('https://example.test'), context)).status).toBe(401);
        expect(mocks.query).not.toHaveBeenCalled();
    });
});
