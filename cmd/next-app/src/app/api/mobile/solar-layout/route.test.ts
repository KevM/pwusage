import { beforeEach, describe, expect, it, vi } from 'vitest';

const { verifyAccessMock, rolesMock, getMock, setLocationMock } = vi.hoisted(() => ({
    verifyAccessMock: vi.fn(), rolesMock: vi.fn(), getMock: vi.fn(), setLocationMock: vi.fn(),
}));

vi.mock('@/lib/auth-checks', () => ({ verifySiteAccess: verifyAccessMock, getCurrentRoles: rolesMock }));
vi.mock('@/lib/solar-layout-repo', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/solar-layout-repo')>()),
    SolarLayoutRepo: class { get = getMock; setLocation = setLocationMock; },
}));

import { GET, POST } from './route';

const URL_BASE = 'https://example.test/api/mobile/solar-layout';

function row(overrides: Record<string, unknown> = {}) {
    return {
        siteId: 'site-a', latitude: 43.39, longitude: -87.87, locationSetAt: new Date('2026-10-01T00:00:00Z'),
        result: null, status: 'pending', detectedAt: null, attemptedAt: null, detectorVersion: null, ...overrides,
    };
}

const detectedResult = {
    status: 'detected', confidence: 'high', reasons: [], acClipKw: null, historyDays: 366, clearDays: 42,
    firstDay: '2025-10-28', lastDay: '2026-10-27', shading: [],
    planes: [
        { azimuth: 108.9, tilt: 19.3, dcKwp: 5.03, effectiveKw: 4.28, azimuthRange90: [107, 111], tiltRange90: [18, 21] },
        { azimuth: 277, tilt: 21, dcKwp: 5.62, effectiveKw: 4.77, azimuthRange90: [275, 279], tiltRange90: [20, 22] },
    ],
};

function post(body: unknown) {
    return POST(new Request(URL_BASE, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'application/json' } }));
}

describe('mobile solar layout route', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        verifyAccessMock.mockResolvedValue(true);
        rolesMock.mockResolvedValue(['solar-forecast-beta']);
        getMock.mockResolvedValue(null);
        setLocationMock.mockResolvedValue(undefined);
    });

    it('GET requires a siteId and access, with private no-store headers', async () => {
        const missing = await GET(new Request(URL_BASE));
        expect(missing.status).toBe(400);
        expect(missing.headers.get('Cache-Control')).toBe('private, no-store, max-age=0');
        verifyAccessMock.mockResolvedValue(false);
        expect((await GET(new Request(`${URL_BASE}?siteId=site-a`))).status).toBe(401);
        expect(getMock).not.toHaveBeenCalled();
    });

    it('GET reports the feature as disabled for users without the beta role', async () => {
        rolesMock.mockResolvedValue(['admin']);
        const res = await GET(new Request(`${URL_BASE}?siteId=site-a`));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ version: 1, enabled: false });
        expect(getMock).not.toHaveBeenCalled();
    });

    it('GET asks for a location when none is stored', async () => {
        const body = await (await GET(new Request(`${URL_BASE}?siteId=site-a`))).json();
        expect(body).toEqual({ version: 1, enabled: true, location: null, layout: null, reason: 'needs-location' });
    });

    it('GET withholds a low-confidence layout', async () => {
        getMock.mockResolvedValue(row({ status: 'low-confidence', result: { ...detectedResult, status: 'low-confidence', confidence: 'low' } }));
        const body = await (await GET(new Request(`${URL_BASE}?siteId=site-a`))).json();
        expect(body).toMatchObject({ enabled: true, location: { latitude: 43.39, longitude: -87.87 }, layout: null, reason: 'low-confidence' });
    });

    it('GET serves a detected layout in compass degrees with DC size', async () => {
        getMock.mockResolvedValue(row({ status: 'detected', result: detectedResult, detectedAt: new Date('2026-10-27T12:00:00Z') }));
        const body = await (await GET(new Request(`${URL_BASE}?siteId=site-a`))).json();
        expect(body).toEqual({
            version: 1, enabled: true, location: { latitude: 43.39, longitude: -87.87 }, reason: null,
            layout: {
                planes: [{ azimuth: 108.9, tilt: 19.3, dcKwp: 5.03 }, { azimuth: 277, tilt: 21, dcKwp: 5.62 }],
                acClipKw: null, confidence: 'high', detectedAt: '2026-10-27T12:00:00.000Z',
            },
        });
    });

    it('POST refuses a site the user cannot access and stores nothing', async () => {
        verifyAccessMock.mockResolvedValue(false);
        expect((await post({ siteId: 'site-b', latitude: 43.39, longitude: -87.87 })).status).toBe(401);
        expect(setLocationMock).not.toHaveBeenCalled();
    });

    it('POST is beta-only', async () => {
        rolesMock.mockResolvedValue([]);
        expect((await post({ siteId: 'site-a', latitude: 43.39, longitude: -87.87 })).status).toBe(403);
        expect(setLocationMock).not.toHaveBeenCalled();
    });

    it('POST rejects invalid coordinates', async () => {
        for (const body of [
            { siteId: 'site-a', latitude: 'abc', longitude: -87.87 },
            { siteId: 'site-a', latitude: 91, longitude: -87.87 },
            { siteId: 'site-a', latitude: 43, longitude: -180.5 },
            { siteId: 'site-a', latitude: null, longitude: 10 },
            { latitude: 43, longitude: 10 },
            'not json',
        ]) {
            expect((await post(body)).status).toBe(400);
        }
        expect(setLocationMock).not.toHaveBeenCalled();
    });

    it('POST stores the location rounded to two decimals', async () => {
        const res = await post({ siteId: 'site-a', latitude: 43.39321, longitude: -87.87154 });
        expect(res.status).toBe(204);
        expect(setLocationMock).toHaveBeenCalledWith('site-a', 43.39, -87.87);
    });
});
