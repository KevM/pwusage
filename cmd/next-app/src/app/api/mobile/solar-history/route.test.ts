import { Temporal } from '@js-temporal/polyfill';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { verifyAccessMock, rolesMock, siteMock, readDaysMock, boundaryMock, clientMock, ensureMock } = vi.hoisted(() => ({
    verifyAccessMock: vi.fn(), rolesMock: vi.fn(), siteMock: vi.fn(), readDaysMock: vi.fn(),
    boundaryMock: vi.fn(), clientMock: vi.fn(), ensureMock: vi.fn(),
}));

vi.mock('@/lib/auth-checks', () => ({ verifySiteAccess: verifyAccessMock, getCurrentRoles: rolesMock }));
vi.mock('@/lib/site-repo', () => ({ SiteRepo: class { getSite = siteMock; getHistoryBackfillFrom = boundaryMock; } }));
vi.mock('@/lib/db', () => ({ pool: {} }));
vi.mock('@/lib/prototypes/compact-history-store', () => ({ CompactHistoryStore: class { readSolarDays = readDaysMock; } }));
vi.mock('@/lib/tesla-client-factory', () => ({ createTeslaClientForSite: clientMock }));
vi.mock('@/lib/importer', () => ({ Importer: class { ensureDataForRange = ensureMock; } }));

import { TeslaRateLimitError } from '@/lib/tesla-client';
import { TeslaConnectionRequiredError, TeslaRefreshBackoffError } from '@/lib/tesla-refresh-outcome';
import { GET, POST } from './route';

const URL_BASE = 'https://example.test/api/mobile/solar-history';
const TZ = 'America/Chicago';
const SLOT_MS = 300000;
const NO_STORE = 'private, no-store, max-age=0';

/** Site-local midnight of a calendar day, as a UTC instant. */
const midnight = (date: string) => new Date(Temporal.PlainDate.from(date).toZonedDateTime({ timeZone: TZ }).toInstant().epochMilliseconds);
const sample = (timestamp: Date, solarWh: number) => ({ timestamp, solarWh });
const dayRow = (dayStart: Date, samples: { timestamp: Date; solarWh: number }[] = [], overrides: Record<string, unknown> = {}) => ({
    dayStart, status: 'complete', fetchedAt: new Date('2026-10-27T12:00:00Z'), expectedSlots: 288, samples, ...overrides,
});
const get = (query: string) => GET(new Request(`${URL_BASE}?${query}`));

describe('mobile solar history route', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // 2026-10-27 13:30 in Chicago.
        vi.setSystemTime(new Date('2026-10-27T18:30:00.000Z'));
        verifyAccessMock.mockResolvedValue(true);
        rolesMock.mockResolvedValue(['solar-forecast-beta']);
        siteMock.mockResolvedValue({ id: 'site-a', timezone: TZ });
        readDaysMock.mockReset();
        readDaysMock.mockResolvedValue([]);
    });

    it('requires a siteId and a valid from', async () => {
        expect((await get('from=2026-10-20')).status).toBe(400);
        expect((await get('siteId=site-a')).status).toBe(400);
        expect(readDaysMock).not.toHaveBeenCalled();
    });

    it.each(['2026-10', '2026-1-05', '2026-02-30', '2026-10-20T00:00', 'yesterday'])('rejects from=%s', async from => {
        const res = await get(`siteId=site-a&from=${from}`);
        expect(res.status).toBe(400);
        expect(res.headers.get('Cache-Control')).toBe(NO_STORE);
        expect(readDaysMock).not.toHaveBeenCalled();
    });

    it.each(['yesterday', '2026-13-01T00:00:00Z', '2026-10-20'])('rejects changedSince=%s', async changedSince => {
        expect((await get(`siteId=site-a&from=2026-10-20&changedSince=${changedSince}`)).status).toBe(400);
        expect(readDaysMock).not.toHaveBeenCalled();
    });

    it('requires access to the site', async () => {
        verifyAccessMock.mockResolvedValueOnce(false);
        const res = await get('siteId=site-a&from=2026-10-20');
        expect(res.status).toBe(401);
        expect(res.headers.get('Cache-Control')).toBe(NO_STORE);
        expect(readDaysMock).not.toHaveBeenCalled();
    });

    it('answers enabled:false without the beta role, and reads nothing', async () => {
        rolesMock.mockResolvedValueOnce([]);
        const res = await get('siteId=site-a&from=2026-10-20');
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ version: 1, enabled: false });
        expect(readDaysMock).not.toHaveBeenCalled();
    });

    it('returns 404 for a missing site', async () => {
        siteMock.mockResolvedValueOnce(null);
        expect((await get('siteId=site-a&from=2026-10-20')).status).toBe(404);
    });

    it('returns 500 when the read fails', async () => {
        readDaysMock.mockRejectedValueOnce(new Error('db down'));
        const res = await get('siteId=site-a&from=2026-10-20');
        expect(res.status).toBe(500);
        expect(res.headers.get('Cache-Control')).toBe(NO_STORE);
    });

    it('reads the site-local window from the day through today, with the day limit plus one and the changedSince watermark', async () => {
        const changedSince = '2026-10-26T00:00:00.000Z';
        const res = await get(`siteId=site-a&from=2026-10-20&changedSince=${changedSince}`);
        expect(res.status).toBe(200);
        expect(res.headers.get('Cache-Control')).toBe(NO_STORE);
        expect(await res.json()).toEqual({ version: 1, enabled: true, timeZone: TZ, days: [], nextFrom: null });
        expect(readDaysMock).toHaveBeenCalledWith('site-a', midnight('2026-10-20'), midnight('2026-10-28'), new Date(changedSince), 93);
        expect(midnight('2026-10-20').toISOString()).toBe('2026-10-20T05:00:00.000Z');
        expect(midnight('2026-10-28').toISOString()).toBe('2026-10-28T05:00:00.000Z');
    });

    it('passes a null watermark when changedSince is absent', async () => {
        await get('siteId=site-a&from=2026-10-20');
        expect(readDaysMock.mock.calls[0][3]).toBeNull();
    });

    it('answers no days for a from after today, without reading', async () => {
        const res = await get('siteId=site-a&from=2026-10-28');
        expect(await res.json()).toEqual({ version: 1, enabled: true, timeZone: TZ, days: [], nextFrom: null });
        expect(readDaysMock).not.toHaveBeenCalled();
    });

    it('takes today in the site timezone, not UTC', async () => {
        // 2026-10-27 03:00 UTC is still 2026-10-26 in Chicago, so the 27th is in the future.
        vi.setSystemTime(new Date('2026-10-27T03:00:00.000Z'));
        expect(await (await get('siteId=site-a&from=2026-10-27')).json()).toMatchObject({ days: [], nextFrom: null });
        expect(readDaysMock).not.toHaveBeenCalled();
    });

    it('serves any date in the past, so a new phone can read the full history', async () => {
        for (const from of ['2025-09-22', '2025-09-21', '2018-03-01']) {
            readDaysMock.mockClear();
            const res = await get(`siteId=site-a&from=${from}`);
            expect(res.status).toBe(200);
            expect(readDaysMock.mock.calls[0][1]).toEqual(midnight(from));
        }
    });

    it('maps each day to its site-local date, slots and fetch state', async () => {
        const start = midnight('2026-10-20');
        readDaysMock.mockResolvedValueOnce([dayRow(start, [
            sample(start, 12.345), sample(new Date(+start + 5 * SLOT_MS), 100), sample(new Date(+start + 2 * SLOT_MS), 12.36),
        ])]);
        const body = await (await get('siteId=site-a&from=2026-10-20')).json();
        expect(body.days).toHaveLength(1);
        expect(body.days[0]).toEqual({
            day: '2026-10-20', dayStart: '2026-10-20T05:00:00.000Z', status: 'complete', fetchedAt: '2026-10-27T12:00:00.000Z',
            solarWh: expect.any(Array),
        });
        const { solarWh } = body.days[0];
        expect(solarWh).toHaveLength(288);
        expect(solarWh[0]).toBe(12.3);
        expect(solarWh[2]).toBe(12.4);
        expect(solarWh[5]).toBe(100);
        expect(solarWh[1]).toBeNull();
        expect(solarWh[287]).toBeNull();
    });

    it('answers a spring-forward day with 276 slots, a fall-back day with 300', async () => {
        vi.setSystemTime(new Date('2026-11-02T12:00:00Z'));
        const fall = midnight('2026-11-01');
        readDaysMock.mockResolvedValueOnce([dayRow(fall, [sample(new Date(+fall + 299 * SLOT_MS), 7)], { expectedSlots: 300 })]);
        const body = await (await get('siteId=site-a&from=2026-11-01')).json();
        expect(body.days[0].day).toBe('2026-11-01');
        expect(body.days[0].solarWh).toHaveLength(300);
        expect(body.days[0].solarWh[299]).toBe(7);
        expect(body.days[0].solarWh.slice(0, 299).every((slot: number | null) => slot === null)).toBe(true);

        const spring = midnight('2026-03-08');
        readDaysMock.mockResolvedValueOnce([dayRow(spring, [], { expectedSlots: 276, status: 'empty' })]);
        const springBody = await (await get('siteId=site-a&from=2026-03-08')).json();
        expect(springBody.days[0].solarWh).toHaveLength(276);
    });

    it('drops off-grid samples and anything outside the day', async () => {
        const start = midnight('2026-10-20');
        readDaysMock.mockResolvedValueOnce([dayRow(start, [
            sample(new Date(+start + SLOT_MS + 1000), 50), sample(new Date(+start - SLOT_MS), 60), sample(new Date(+start + 288 * SLOT_MS), 70),
        ])]);
        const { solarWh } = (await (await get('siteId=site-a&from=2026-10-20')).json()).days[0];
        expect(solarWh.every((slot: number | null) => slot === null)).toBe(true);
    });

    it('answers an empty day with all slots null and no samples', async () => {
        const start = midnight('2026-10-20');
        readDaysMock.mockResolvedValueOnce([dayRow(start, [], { status: 'empty', fetchedAt: null })]);
        const { days } = await (await get('siteId=site-a&from=2026-10-20')).json();
        expect(days[0]).toMatchObject({ status: 'empty', fetchedAt: null });
        expect(days[0].solarWh).toEqual(Array(288).fill(null));
    });

    it('pages 92 days at a time, with nextFrom on the day after the last one returned', async () => {
        vi.setSystemTime(new Date('2027-01-05T12:00:00Z'));
        const firstPage = Array.from({ length: 93 }, (_, i) => dayRow(midnight(Temporal.PlainDate.from('2026-10-01').add({ days: i }).toString())));
        readDaysMock.mockResolvedValueOnce(firstPage);
        const first = await (await get('siteId=site-a&from=2026-10-01')).json();
        expect(readDaysMock.mock.calls[0][4]).toBe(93);
        expect(first.days).toHaveLength(92);
        expect(first.days.at(0).day).toBe('2026-10-01');
        expect(first.days.at(-1).day).toBe('2026-12-31');
        expect(first.nextFrom).toBe('2027-01-01');

        readDaysMock.mockResolvedValueOnce([dayRow(midnight('2027-01-01'))]);
        const second = await (await get(`siteId=site-a&from=${first.nextFrom}`)).json();
        expect(second.days.map((d: { day: string }) => d.day)).toEqual(['2027-01-01']);
        expect(second.nextFrom).toBeNull();
        expect(readDaysMock.mock.calls[1][1]).toEqual(midnight('2027-01-01'));
    });

    it('returns nextFrom null when the read holds no more than a page', async () => {
        readDaysMock.mockResolvedValueOnce(Array.from({ length: 92 }, (_, i) => dayRow(midnight(Temporal.PlainDate.from('2026-10-01').add({ days: i }).toString()))));
        const body = await (await get('siteId=site-a&from=2026-10-01')).json();
        expect(body.days).toHaveLength(92);
        expect(body.nextFrom).toBeNull();
    });
});

describe('mobile solar history fill', () => {
    const fill = (body: unknown) => POST(new Request(URL_BASE, {
        method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'Content-Type': 'application/json' },
    }));
    const valid = { siteId: 'site-a', from: '2026-10-24', days: 3 };

    beforeEach(() => {
        vi.clearAllMocks();
        vi.setSystemTime(new Date('2026-10-27T18:30:00.000Z'));
        verifyAccessMock.mockResolvedValue(true);
        rolesMock.mockResolvedValue(['solar-forecast-beta']);
        siteMock.mockResolvedValue({ id: 'site-a', timezone: TZ, installed: new Date('2024-03-10T17:00:00Z') });
        boundaryMock.mockResolvedValue(null);
        clientMock.mockResolvedValue({});
        ensureMock.mockReset();
        ensureMock.mockResolvedValue({ complete: true, rows: [], processedWindows: 3, totalWindows: 3 });
        readDaysMock.mockReset();
        readDaysMock.mockResolvedValue([]);
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    it.each([
        ['malformed JSON', '{'],
        ['a missing siteId', { from: '2026-10-24', days: 1 }],
        ['an impossible date', { siteId: 'site-a', from: '2026-02-30', days: 1 }],
        ['zero days', { ...valid, days: 0 }],
        ['more than three days', { ...valid, from: '2026-10-23', days: 4 }],
        ['fractional days', { ...valid, days: 1.5 }],
        ['a range reaching today', { ...valid, from: '2026-10-25' }],
    ])('rejects %s without importing', async (_label, body) => {
        const res = await fill(body);
        expect(res.status).toBe(400);
        expect(res.headers.get('Cache-Control')).toBe(NO_STORE);
        expect(ensureMock).not.toHaveBeenCalled();
    });

    it('sets no limit on how far back a fill may start; the history start bounds it', async () => {
        expect((await fill({ ...valid, from: '2019-06-01', days: 1 })).status).toBe(200);
        expect(ensureMock).not.toHaveBeenCalled();
        siteMock.mockResolvedValueOnce({ id: 'site-a', timezone: TZ, installed: new Date('2019-01-01T18:00:00Z') });
        expect((await fill({ ...valid, from: '2019-06-01', days: 1 })).status).toBe(200);
        expect(ensureMock.mock.calls[0][1]).toEqual(midnight('2019-06-01'));
    });

    it('requires access to the site', async () => {
        verifyAccessMock.mockResolvedValueOnce(false);
        expect((await fill(valid)).status).toBe(401);
        expect(ensureMock).not.toHaveBeenCalled();
    });

    it('answers enabled:false without the beta role, and imports nothing', async () => {
        rolesMock.mockResolvedValueOnce([]);
        expect(await (await fill(valid)).json()).toEqual({ version: 1, enabled: false });
        expect(ensureMock).not.toHaveBeenCalled();
    });

    it('fills the site-local slice with a short budget, then returns its stored days', async () => {
        const start = midnight('2026-10-24');
        readDaysMock.mockResolvedValueOnce([dayRow(start, [sample(start, 5)])]);
        const res = await fill(valid);
        expect(res.status).toBe(200);
        expect(res.headers.get('Cache-Control')).toBe(NO_STORE);
        expect(clientMock).toHaveBeenCalledWith('site-a', { rateLimit: 'surface' });
        expect(ensureMock).toHaveBeenCalledWith('site-a', start, midnight('2026-10-27'), undefined, { maxWindows: 3, maxTimeMs: 15000 });
        expect(readDaysMock).toHaveBeenCalledWith('site-a', start, midnight('2026-10-27'), null, 3);
        const body = await res.json();
        expect(body).toMatchObject({ version: 1, enabled: true, timeZone: TZ, status: 'complete', historyStart: '2024-03-10' });
        expect(body.days.map((d: { day: string }) => d.day)).toEqual(['2026-10-24']);
        expect(body.days[0].solarWh[0]).toBe(5);
    });

    it('reports a partial run and a busy lock as their own statuses', async () => {
        ensureMock.mockResolvedValueOnce({ complete: false, rows: [], processedWindows: 1, totalWindows: 3 });
        expect(await (await fill(valid)).json()).toMatchObject({ status: 'partial' });
        ensureMock.mockResolvedValueOnce({ complete: false, rows: [], processedWindows: 0, totalWindows: 0 });
        expect(await (await fill(valid)).json()).toMatchObject({ status: 'busy' });
    });

    it('answers a slice before the history start as complete without calling Tesla', async () => {
        boundaryMock.mockResolvedValueOnce(midnight('2026-10-27'));
        const body = await (await fill(valid)).json();
        expect(body).toMatchObject({ status: 'complete', historyStart: '2026-10-27', days: [] });
        expect(clientMock).not.toHaveBeenCalled();
        expect(ensureMock).not.toHaveBeenCalled();
    });

    it('clips the import at the history start but reads the whole slice', async () => {
        boundaryMock.mockResolvedValueOnce(midnight('2026-10-25'));
        await fill(valid);
        expect(ensureMock.mock.calls[0][1]).toEqual(midnight('2026-10-25'));
        expect(readDaysMock.mock.calls[0][1]).toEqual(midnight('2026-10-24'));
    });

    it('asks for a Tesla reconnect when the account has no usable connection', async () => {
        clientMock.mockResolvedValueOnce(null);
        const res = await fill(valid);
        expect(res.status).toBe(409);
        expect(await res.json()).toMatchObject({ code: 'TESLA_CONNECTION_REQUIRED' });
        ensureMock.mockRejectedValueOnce(new TeslaConnectionRequiredError());
        expect((await fill(valid)).status).toBe(409);
    });

    it('returns 529 with Tesla\'s Retry-After when Tesla throttles, even after partial writes', async () => {
        ensureMock.mockRejectedValueOnce(new TeslaRateLimitError(new Date('2026-10-27T19:30:00.000Z'), 'header'));
        const res = await fill(valid);
        expect(res.status).toBe(529);
        expect(res.headers.get('Retry-After')).toBe('3600');
        expect(res.headers.get('Cache-Control')).toBe(NO_STORE);
        expect(await res.json()).toEqual({ error: 'Tesla is limiting requests', code: 'TESLA_RATE_LIMITED',
            retryAt: '2026-10-27T19:30:00.000Z', retryAfterSource: 'header' });
        expect(readDaysMock).not.toHaveBeenCalled();
    });

    it('rounds a sub-second Retry-After up and keeps a fallback labelled', async () => {
        ensureMock.mockRejectedValueOnce(new TeslaRateLimitError(new Date(Date.now() + 1500), 'fallback'));
        const res = await fill(valid);
        expect(res.headers.get('Retry-After')).toBe('2');
        expect(await res.json()).toMatchObject({ retryAfterSource: 'fallback' });
    });

    it('returns 503 with Retry-After while a token refresh backs off', async () => {
        ensureMock.mockRejectedValueOnce(new TeslaRefreshBackoffError(Date.now() + 120_000));
        const res = await fill(valid);
        expect(res.status).toBe(503);
        expect(res.headers.get('Retry-After')).toBe('120');
        expect(await res.json()).toMatchObject({ code: 'TESLA_REFRESH_BACKOFF' });
    });

    it('returns 500 on any other failure', async () => {
        ensureMock.mockRejectedValueOnce(new Error('Tesla API Error: 500'));
        expect((await fill(valid)).status).toBe(500);
    });
});
