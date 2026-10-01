import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { access, getSite, currency, createClient, ensureSite } = vi.hoisted(() => ({ access: vi.fn(), getSite: vi.fn(), currency: vi.fn(), createClient: vi.fn(), ensureSite: vi.fn() }));
vi.mock('@/lib/auth-checks', () => ({ verifySiteAccess: access }));
vi.mock('@/lib/site-repo', () => ({ SiteRepo: class { getSite = getSite; getSiteCurrencyCode = currency; } }));
vi.mock('@/lib/tesla-client-factory', () => ({ createTeslaClientForSite: createClient }));
vi.mock('@/lib/importer', () => ({ Importer: class { ensureSite = ensureSite; } }));
import { GET, POST } from './route';
import { NextRequest } from 'next/server';

const period = (id: number, name: string, from: number | null, to: number | null, day = 0, endDay = 6) => ({
    id, season_id: 2, name, buy_rate: null, sell_rate: null,
    from_hour: from, to_hour: to, from_minute: 0, to_minute: 0, from_day_of_week: day, to_day_of_week: endDay,
});
const site = { id: 'a', name: 'Home', timezone: 'America/Chicago', tariffs: [{ id: 1, name: 'Residential', seasons: [{
    id: 2, name: 'Winter', from_month: 10, from_day: 1, to_month: 4, to_day: 30, buy_rate: 0.3, sell_rate: 0.1,
    schedules: [period(3, 'Peak', 8, 20), period(4, 'Off peak', 20, 8), period(5, 'Weekend', null, null, 5, 6)],
}] }] };
const request = () => new Request('https://example.test/api/site/a/refresh-tariffs');
const context = { params: Promise.resolve({ id: 'a' }) };
const read = () => GET(request(), context);
describe('shared tariff route', () => {
    beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-01T13:00:00Z')); access.mockResolvedValue(true); getSite.mockResolvedValue(site); currency.mockResolvedValue('USD'); });
    afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
    it('reads the route site rather than an unrelated query parameter', async () => {
        await GET(new Request('https://example.test/api/site/a/refresh-tariffs?siteId=other'), context);
        expect(access).toHaveBeenCalledWith('a');
        expect(getSite).toHaveBeenCalledWith('a');
    });
    it('authorizes before reading tariffs', async () => { access.mockResolvedValue(false); expect((await read()).status).toBe(401); expect(getSite).not.toHaveBeenCalled(); });
    it('returns missing site', async () => { getSite.mockResolvedValue(undefined); expect((await read()).status).toBe(404); });
    it('resolves site-local season, rate fallback, and active period at its boundary', async () => {
        const response = await read(); const body = await response.json();
        expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0');
        expect(body.site).toEqual({ id: 'a', name: 'Home', timezone: 'America/Chicago' });
        expect(body.tariffs[0].seasons[0]).toMatchObject({ isActive: true });
        expect(body.tariffs[0].seasons[0].periods[0]).toMatchObject({ isActive: true, buyRate: 0.3, sellRate: 0.1, days: 'Mon – Fri' });
        expect(body.tariffs[0].seasons[0].periods[1].isActive).toBe(false);
    });
    it('uses weekend override', async () => {
        vi.setSystemTime(new Date('2026-10-03T15:00:00Z'));
        const body = await (await read()).json();
        expect(body.tariffs[0].seasons[0].periods.map((p: { isActive: boolean }) => p.isActive)).toEqual([false, false, true]);
    });
    it('marks wrapping winter season active in January', async () => {
        vi.setSystemTime(new Date('2027-01-02T15:00:00Z'));
        expect((await (await read()).json()).tariffs[0].seasons[0].isActive).toBe(true);
    });
    it('uses minute boundaries and half-open period windows', async () => {
        const minuteSite = structuredClone(site);
        minuteSite.tariffs[0].seasons[0].schedules[0].from_minute = 7;
        minuteSite.tariffs[0].seasons[0].schedules[1].to_minute = 7;
        getSite.mockResolvedValue(minuteSite);
        vi.setSystemTime(new Date('2026-10-01T13:06:00Z'));
        let body = await (await read()).json();
        expect(body.tariffs[0].seasons[0].periods[1].isActive).toBe(true);
        vi.setSystemTime(new Date('2026-10-01T13:07:00Z'));
        body = await (await read()).json();
        expect(body.tariffs[0].seasons[0].periods[0].isActive).toBe(true);
        expect(body.tariffs[0].seasons[0].periods[1].isActive).toBe(false);
    });
    it('selects the site-local season across a UTC date boundary', async () => {
        vi.setSystemTime(new Date('2026-10-01T02:00:00Z'));
        const body = await (await read()).json();
        expect(body.tariffs[0].seasons[0].isActive).toBe(false);
        expect(body.tariffs[0].seasons[0].periods.every((p: { isActive: boolean }) => !p.isActive)).toBe(true);
    });
    it('handles overnight periods and holidays through the shared resolver', async () => {
        vi.setSystemTime(new Date('2026-10-02T06:00:00Z'));
        let body = await (await read()).json();
        expect(body.tariffs[0].seasons[0].periods[1].isActive).toBe(true);
        vi.setSystemTime(new Date('2027-01-01T15:00:00Z'));
        body = await (await read()).json();
        expect(body.tariffs[0].seasons[0].periods[2].isActive).toBe(true);
    });
    it('marks the season even without a matching period', async () => {
        const emptySeason = structuredClone(site);
        emptySeason.tariffs[0].seasons[0].schedules = [];
        getSite.mockResolvedValue(emptySeason);
        const body = await (await read()).json();
        expect(body.tariffs[0].seasons[0]).toMatchObject({ isActive: true, periods: [] });
    });
    it('returns empty tariff list', async () => { getSite.mockResolvedValue({ ...site, tariffs: [] }); expect((await (await read()).json()).tariffs).toEqual([]); });
    it('GET never refreshes rates through Tesla', async () => {
        await read();
        expect(createClient).not.toHaveBeenCalled();
        expect(ensureSite).not.toHaveBeenCalled();
    });
    it('POST preserves the existing Tesla refresh behavior', async () => {
        createClient.mockResolvedValue({});
        ensureSite.mockResolvedValue(site);
        const response = await POST(new NextRequest(request().url, { method: 'POST' }), context);
        expect(response.status).toBe(200);
        expect(ensureSite).toHaveBeenCalledWith('a');
        expect(await response.json()).toMatchObject({ success: true, tariffCount: 1 });
    });
    it('POST checks access before contacting Tesla', async () => {
        access.mockResolvedValue(false);
        const response = await POST(new NextRequest(request().url, { method: 'POST' }), context);
        expect(response.status).toBe(403);
        expect(createClient).not.toHaveBeenCalled();
    });

});
