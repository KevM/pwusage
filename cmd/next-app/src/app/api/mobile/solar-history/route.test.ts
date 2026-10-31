import { Temporal } from '@js-temporal/polyfill';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { verifyAccessMock, rolesMock, siteMock, readDaysMock } = vi.hoisted(() => ({
    verifyAccessMock: vi.fn(), rolesMock: vi.fn(), siteMock: vi.fn(), readDaysMock: vi.fn(),
}));

vi.mock('@/lib/auth-checks', () => ({ verifySiteAccess: verifyAccessMock, getCurrentRoles: rolesMock }));
vi.mock('@/lib/site-repo', () => ({ SiteRepo: class { getSite = siteMock; } }));
vi.mock('@/lib/db', () => ({ pool: {} }));
vi.mock('@/lib/prototypes/compact-history-store', () => ({ CompactHistoryStore: class { readSolarDays = readDaysMock; } }));

import { GET } from './route';

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

    it('accepts a from exactly 400 days back and refuses one more', async () => {
        const exact = await get('siteId=site-a&from=2025-09-22');
        expect(exact.status).toBe(200);
        expect(readDaysMock.mock.calls[0][1]).toEqual(midnight('2025-09-22'));
        expect((await get('siteId=site-a&from=2025-09-21')).status).toBe(400);
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
