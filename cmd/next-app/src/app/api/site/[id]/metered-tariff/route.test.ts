import { describe, it, expect, vi, beforeEach } from 'vitest';

const { verifyMock, setDateMock, addHistoricMock, replaceMock, listMock, installedMock, structMock } = vi.hoisted(() => ({
    verifyMock: vi.fn(), setDateMock: vi.fn(), addHistoricMock: vi.fn(), replaceMock: vi.fn(),
    listMock: vi.fn(), installedMock: vi.fn(), structMock: vi.fn(),
}));
vi.mock('@/lib/auth-checks', () => ({ verifySiteAccess: verifyMock }));
vi.mock('@/lib/tariff-repo', () => ({
    TariffRepo: class {
        setMeteredEffectiveFrom = setDateMock;
        addHistoricMeteredVersion = addHistoricMock;
        replaceMeteredVersion = replaceMock;
        listMeteredVersions = listMock;
        getSiteInstalledDate = installedMock;
        getMeteredVersionStructure = structMock;
    },
}));

import { GET, PATCH, POST, PUT } from './route';

function req(body: unknown, url = 'http://test/api/site/s1/metered-tariff') {
    return new Request(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }) as unknown as import('next/server').NextRequest;
}
function getReq(url: string) {
    return new Request(url) as unknown as import('next/server').NextRequest;
}
const params = Promise.resolve({ id: 's1' });
const fullYearSeasons = [{
    name: 'All Year', from_month: 1, from_day: 1, to_month: 12, to_day: 31, buy_rate: 0.2, sell_rate: 0.05,
    schedules: [{ name: 'W', buy_rate: 0.2, sell_rate: 0.05, from_day_of_week: 0, to_day_of_week: 6, from_hour: 0, from_minute: 0, to_hour: 24, to_minute: 0 }],
}];

beforeEach(() => {
    vi.clearAllMocks();
    verifyMock.mockResolvedValue(true);
    installedMock.mockResolvedValue('2020-01-15');
    // default lineage: a single current version anchored at install
    listMock.mockResolvedValue([{ version: 1, effective_from: '2020-01-15', is_current: true }]);
});

describe('metered-tariff GET (version structure)', () => {
    it('403 without access', async () => {
        verifyMock.mockResolvedValue(false);
        const res = await GET(getReq('http://test/api/site/s1/metered-tariff?version=2'), { params });
        expect(res.status).toBe(403);
    });
    it('returns the parsed structure for a version', async () => {
        structMock.mockResolvedValue({ name: 'PG&E', seasons: fullYearSeasons });
        const res = await GET(getReq('http://test/api/site/s1/metered-tariff?version=2'), { params });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ name: 'PG&E', seasons: fullYearSeasons });
        expect(structMock).toHaveBeenCalledWith('s1', 2);
    });
    it('404 when the version is absent', async () => {
        structMock.mockResolvedValue(null);
        const res = await GET(getReq('http://test/api/site/s1/metered-tariff?version=9'), { params });
        expect(res.status).toBe(404);
    });
});

describe('metered-tariff PATCH (date-only)', () => {
    it('403 without access', async () => {
        verifyMock.mockResolvedValue(false);
        const res = await PATCH(req({ version: 1, effective_from: '2021-01-01' }), { params });
        expect(res.status).toBe(403);
    });
    it('400 when version missing', async () => {
        const res = await PATCH(req({ effective_from: '2021-01-01' }), { params });
        expect(res.status).toBe(400);
    });
    it('clearing the date snaps the earliest back to the install date (never null)', async () => {
        const res = await PATCH(req({ version: 1, effective_from: null }), { params });
        expect(res.status).toBe(200);
        expect(setDateMock).toHaveBeenCalledWith('s1', 1, '2020-01-15');
    });
    it('sets a date and keeps the lineage ordered', async () => {
        listMock.mockResolvedValue([
            { version: 1, effective_from: '2020-01-15', is_current: false },
            { version: 2, effective_from: '2025-01-01', is_current: true },
        ]);
        const res = await PATCH(req({ version: 2, effective_from: '2024-06-01' }), { params });
        expect(res.status).toBe(200);
        expect(setDateMock).toHaveBeenCalledWith('s1', 2, '2024-06-01');
    });
    it('400 on a non-monotonic date (would overtake a later version)', async () => {
        listMock.mockResolvedValue([
            { version: 1, effective_from: '2020-01-15', is_current: false },
            { version: 2, effective_from: '2025-01-01', is_current: true },
        ]);
        const res = await PATCH(req({ version: 1, effective_from: '2026-01-01' }), { params });
        expect(res.status).toBe(400);
        expect(setDateMock).not.toHaveBeenCalled();
    });
});

describe('metered-tariff POST (add historic, one date)', () => {
    it('400 on a coverage gap', async () => {
        const res = await POST(req({ switch_date: '2024-01-01', seasons: [] }), { params });
        expect(res.status).toBe(400);
        expect(addHistoricMock).not.toHaveBeenCalled();
    });
    it('400 when switch_date missing', async () => {
        const res = await POST(req({ seasons: fullYearSeasons }), { params });
        expect(res.status).toBe(400);
    });
    it('400 when switch_date is not after the install date', async () => {
        const res = await POST(req({ switch_date: '2019-01-01', seasons: fullYearSeasons }), { params });
        expect(res.status).toBe(400);
        expect(addHistoricMock).not.toHaveBeenCalled();
    });
    it('creates a historic version with the switch date', async () => {
        const res = await POST(req({ switch_date: '2024-01-01', seasons: fullYearSeasons }), { params });
        expect(res.status).toBe(200);
        expect(addHistoricMock).toHaveBeenCalledWith('s1', expect.objectContaining({ seasons: fullYearSeasons }), '2024-01-01');
    });
});

describe('metered-tariff PUT (edit historic)', () => {
    it('400 on a coverage gap', async () => {
        const res = await PUT(req({ version: 4, effective_from: '2024-01-01', seasons: [] }), { params });
        expect(res.status).toBe(400);
        expect(replaceMock).not.toHaveBeenCalled();
    });
    it('replaces a historic version structure + date', async () => {
        listMock.mockResolvedValue([
            { version: 4, effective_from: '2020-01-15', is_current: false },
            { version: 1, effective_from: '2024-01-01', is_current: true },
        ]);
        const res = await PUT(req({ version: 4, effective_from: '2020-01-15', seasons: fullYearSeasons }), { params });
        expect(res.status).toBe(200);
        expect(replaceMock).toHaveBeenCalledWith('s1', 4, expect.objectContaining({ seasons: fullYearSeasons }), '2020-01-15');
    });
    it('400 when trying to edit the Tesla current version', async () => {
        replaceMock.mockRejectedValue(new Error("Your current plan's rates come from Tesla and can't be edited."));
        listMock.mockResolvedValue([
            { version: 1, effective_from: '2020-01-15', is_current: true },
        ]);
        const res = await PUT(req({ version: 1, effective_from: '2020-01-15', seasons: fullYearSeasons }), { params });
        expect(res.status).toBe(400);
        const j = await res.json();
        expect(j.error).toMatch(/Tesla/);
    });
});
