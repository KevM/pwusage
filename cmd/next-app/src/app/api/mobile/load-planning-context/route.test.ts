import { beforeEach, describe, expect, it, vi } from 'vitest';

const { verifyAccessMock, siteMock, rawMock } = vi.hoisted(() => ({
    verifyAccessMock: vi.fn(), siteMock: vi.fn(), rawMock: vi.fn(),
}));

vi.mock('@/lib/auth-checks', () => ({ verifySiteAccess: verifyAccessMock }));
vi.mock('@/lib/site-repo', () => ({ SiteRepo: class { getSite = siteMock; } }));
vi.mock('@/lib/energy-repo', () => ({ EnergyRepo: class { getRawEnergyData = rawMock; } }));

import { GET } from './route';
import { clearHouseholdPatternCache } from '@/lib/household-pattern-cache';

/** Five-minute rows over [start, end) with constant grid export and solar. */
function steadyRows(start: Date, end: Date, exportKw: number, solarKw: number) {
    const rows = [];
    const wh = (kw: number) => kw * 1000 * 5 / 60;
    for (let time = start.getTime(); time < end.getTime(); time += 5 * 60_000) {
        rows.push({
            timestamp: new Date(time), site_id: 'site-a', tariff_id: 1, tariff_schedule_id: null,
            load_power: wh(1), solar_power: wh(solarKw), grid_power: -wh(exportKw), battery_power: 0, battery_soc: null,
        });
    }
    return rows;
}

describe('mobile load planning context route', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        clearHouseholdPatternCache();
        vi.setSystemTime(new Date('2026-09-27T18:30:00.000Z'));
        verifyAccessMock.mockResolvedValue(true);
        siteMock.mockResolvedValue({ id: 'site-a', name: 'Home', timezone: 'America/Chicago' });
        rawMock.mockResolvedValue([]);
    });

    it('requires a siteId and sets private no-store headers', async () => {
        const response = await GET(new Request('https://example.test/api/mobile/load-planning-context'));

        expect(response.status).toBe(400);
        expect(response.headers.get('Cache-Control')).toContain('private');
        expect(response.headers.get('Cache-Control')).toContain('no-store');
        expect(verifyAccessMock).not.toHaveBeenCalled();
        expect(rawMock).not.toHaveBeenCalled();
    });

    it('authorizes before reading site history and returns 401 when access is denied', async () => {
        verifyAccessMock.mockResolvedValue(false);

        const response = await GET(new Request('https://example.test/api/mobile/load-planning-context?siteId=site-a'));

        expect(response.status).toBe(401);
        expect(siteMock).not.toHaveBeenCalled();
        expect(rawMock).not.toHaveBeenCalled();
    });

    it('returns 404 for an authorized site that no longer exists', async () => {
        siteMock.mockResolvedValue(undefined);

        const response = await GET(new Request('https://example.test/api/mobile/load-planning-context?siteId=site-a'));

        expect(response.status).toBe(404);
        expect(rawMock).not.toHaveBeenCalled();
    });

    it('reads the previous 28 complete site-local days and exposes no forecast fields', async () => {
        const response = await GET(new Request('https://example.test/api/mobile/load-planning-context?siteId=site-a&start=1900-01-01&end=2100-01-01'));
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(rawMock).toHaveBeenCalledTimes(1);
        const [siteId, start, end] = rawMock.mock.calls[0] as [string, Date, Date];
        expect(siteId).toBe('site-a');
        expect(start.toISOString()).toBe('2026-08-30T05:00:00.000Z');
        expect(end.toISOString()).toBe('2026-09-27T05:00:00.000Z');
        expect(body).toMatchObject({
            version: 1,
            site: { id: 'site-a', timezone: 'America/Chicago' },
            units: { power: 'kW', localMinute: 'minute-of-day' },
            asOf: '2026-09-27T18:30:00.000Z',
            // Home and battery still come from the last 14 days.
            historyStart: '2026-09-13T05:00:00.000Z',
            historyEnd: end.toISOString(),
            availability: 'unavailable',
            unavailableReason: 'insufficient-history',
        });
        expect(body.slots).toHaveLength(48);
        expect(JSON.stringify(body)).not.toMatch(/solcast|forecast|resourceId|apiKey/i);
        expect(response.headers.get('Cache-Control')).toContain('private');
        expect(response.headers.get('Cache-Control')).toContain('no-store');
    });

    it('returns 200 context slots with private no-store caching headers', async () => {
        const response = await GET(new Request('https://example.test/api/mobile/load-planning-context?siteId=site-a'));

        expect(response.status).toBe(200);
        expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0');
    });

    it('bounds a skipped-midnight site history at independently resolved Santiago dates', async () => {
        vi.setSystemTime(new Date('2026-09-20T12:00:00.000Z'));
        siteMock.mockResolvedValue({ id: 'site-a', name: 'Home', timezone: 'America/Santiago' });

        const response = await GET(new Request('https://example.test/api/mobile/load-planning-context?siteId=site-a'));
        const body = await response.json();
        const [, start, end] = rawMock.mock.calls[0] as [string, Date, Date];

        expect(response.status).toBe(200);
        expect(start.toISOString()).toBe('2026-08-23T04:00:00.000Z');
        expect(end.toISOString()).toBe('2026-09-20T03:00:00.000Z');
        expect(body.historyStart).toBe('2026-09-06T04:00:00.000Z');
        expect(body.historyEnd).toBe(end.toISOString());
        expect(body.slots).toHaveLength(48);
    });

    it('servesGridHistoryInEachSlot', async () => {
        rawMock.mockImplementation(async (_siteId: string, start: Date, end: Date) => steadyRows(start, end, 2, 3));

        const response = await GET(new Request('https://example.test/api/mobile/load-planning-context?siteId=site-a'));
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.version).toBe(1);
        expect(body.availability).toBe('available');
        expect(body.gridHistory).toEqual({
            usableDayCount: 28,
            historyStart: '2026-08-30T05:00:00.000Z',
            historyEnd: '2026-09-27T05:00:00.000Z',
        });
        expect(body.slots).toHaveLength(48);
        for (const slot of body.slots) {
            expect(slot.homeKw).toBeCloseTo(1, 9);
            expect(slot.gridNetExportKw).toBeCloseTo(2, 9);
            expect(slot.cautiousGridNetExportKw).toBeCloseTo(2, 9);
            expect(slot.solarKw).toBeCloseTo(3, 9);
        }
    });

    it('readsTwentyEightDaysOnce', async () => {
        await GET(new Request('https://example.test/api/mobile/load-planning-context?siteId=site-a'));

        expect(rawMock).toHaveBeenCalledTimes(1);
        const [, start, end] = rawMock.mock.calls[0] as [string, Date, Date];
        expect(start.toISOString()).toBe('2026-08-30T05:00:00.000Z');
        expect(end.toISOString()).toBe('2026-09-27T05:00:00.000Z');
    });

    it('memoizesPerSiteAndLocalDay', async () => {
        const request = () => GET(new Request('https://example.test/api/mobile/load-planning-context?siteId=site-a'));

        await request();
        vi.setSystemTime(new Date('2026-09-28T04:59:00.000Z'));
        const sameDay = await (await request()).json();
        expect(rawMock).toHaveBeenCalledTimes(1);
        expect(sameDay.asOf).toBe('2026-09-28T04:59:00.000Z');

        vi.setSystemTime(new Date('2026-09-28T05:00:00.000Z'));
        await request();
        expect(rawMock).toHaveBeenCalledTimes(2);
    });

    it('does not memoize a failed read', async () => {
        rawMock.mockRejectedValueOnce(new Error('db down'));
        const request = () => GET(new Request('https://example.test/api/mobile/load-planning-context?siteId=site-a'));

        expect((await request()).status).toBe(500);
        expect((await request()).status).toBe(200);
        expect(rawMock).toHaveBeenCalledTimes(2);
    });
});
