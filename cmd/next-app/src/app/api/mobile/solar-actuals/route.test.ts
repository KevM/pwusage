import { beforeEach, describe, expect, it, vi } from 'vitest';

const { verifyAccessMock, rolesMock, siteMock, rawMock } = vi.hoisted(() => ({
    verifyAccessMock: vi.fn(), rolesMock: vi.fn(), siteMock: vi.fn(), rawMock: vi.fn(),
}));

vi.mock('@/lib/auth-checks', () => ({ verifySiteAccess: verifyAccessMock, getCurrentRoles: rolesMock }));
vi.mock('@/lib/site-repo', () => ({ SiteRepo: class { getSite = siteMock; } }));
vi.mock('@/lib/energy-repo-factory', () => ({ createEnergyRepo: () => ({ getRawEnergyData: rawMock }) }));

import { GET } from './route';

const URL_BASE = 'https://example.test/api/mobile/solar-actuals';

describe('mobile solar actuals route', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.setSystemTime(new Date('2026-10-27T18:30:00.000Z'));
        verifyAccessMock.mockResolvedValue(true);
        rolesMock.mockResolvedValue(['solar-forecast-beta']);
        siteMock.mockResolvedValue({ id: 'site-a', timezone: 'America/Chicago' });
        rawMock.mockResolvedValue([{ timestamp: new Date('2026-10-27T15:00:00Z'), solar_power: 100 }]);
    });

    it('requires a siteId, access and the beta role', async () => {
        expect((await GET(new Request(URL_BASE))).status).toBe(400);
        verifyAccessMock.mockResolvedValueOnce(false);
        expect((await GET(new Request(`${URL_BASE}?siteId=site-a`))).status).toBe(401);
        rolesMock.mockResolvedValueOnce([]);
        const res = await GET(new Request(`${URL_BASE}?siteId=site-a`));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ version: 1, enabled: false });
        expect(rawMock).not.toHaveBeenCalled();
    });

    it('returns hourly actuals for the 14 days before today plus today', async () => {
        const res = await GET(new Request(`${URL_BASE}?siteId=site-a`));
        expect(res.headers.get('Cache-Control')).toBe('private, no-store, max-age=0');
        expect(await res.json()).toEqual({
            version: 1, enabled: true, asOf: '2026-10-27T18:30:00.000Z',
            hours: [{ hourStart: '2026-10-27T15:00:00.000Z', wh: 100, complete: false }],
        });
        const [siteId, start, end] = rawMock.mock.calls[0];
        expect(siteId).toBe('site-a');
        expect((start as Date).toISOString()).toBe('2026-10-13T05:00:00.000Z');
        expect((end as Date).toISOString()).toBe('2026-10-27T18:30:00.000Z');
    });
    it('returns incomplete validated partial energy for off-grid data', async () => {
        rawMock.mockResolvedValue([...Array.from({ length: 11 }, (_, i) => ({ timestamp: new Date(Date.parse('2026-10-27T15:00:00Z') + i * 300_000), solar_power: 100 })), { timestamp: new Date('2026-10-27T15:00:01Z'), solar_power: 100 }]);
        const res = await GET(new Request(`${URL_BASE}?siteId=site-a`));
        expect(res.headers.get('Cache-Control')).toBe('private, no-store, max-age=0');
        expect((await res.json()).hours).toEqual([{ hourStart: '2026-10-27T15:00:00.000Z', wh: 1100, complete: false }]);
    });

});
