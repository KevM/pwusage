import { describe, it, expect, vi, beforeEach } from 'vitest';

const { verifyMock, setDateMock, addHistoricMock } = vi.hoisted(() => ({
    verifyMock: vi.fn(), setDateMock: vi.fn(), addHistoricMock: vi.fn(),
}));
vi.mock('@/lib/auth-checks', () => ({ verifySiteAccess: verifyMock }));
vi.mock('@/lib/tariff-repo', () => ({
    TariffRepo: class {
        setMeteredEffectiveFrom = setDateMock;
        addHistoricMeteredVersion = addHistoricMock;
    },
}));

import { PATCH, POST } from './route';

function req(body: unknown) {
    return new Request('http://test/api/site/s1/metered-tariff', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }) as unknown as import('next/server').NextRequest;
}
const params = Promise.resolve({ id: 's1' });
const fullYearSeasons = [{
    name: 'All Year', from_month: 1, from_day: 1, to_month: 12, to_day: 31, buy_rate: 0.2, sell_rate: 0.05,
    schedules: [{ name: 'W', buy_rate: 0.2, sell_rate: 0.05, from_day_of_week: 0, to_day_of_week: 6, from_hour: 0, from_minute: 0, to_hour: 24, to_minute: 0 }],
}];

beforeEach(() => { vi.clearAllMocks(); verifyMock.mockResolvedValue(true); });

describe('metered-tariff PATCH', () => {
    it('403 without access', async () => {
        verifyMock.mockResolvedValue(false);
        const res = await PATCH(req({ version: 2, effective_from: '2025-09-01' }), { params });
        expect(res.status).toBe(403);
    });
    it('sets a version effective date', async () => {
        const res = await PATCH(req({ version: 2, effective_from: '2025-09-01' }), { params });
        expect(res.status).toBe(200);
        expect(setDateMock).toHaveBeenCalledWith('s1', 2, '2025-09-01');
    });
    it('400 when version missing', async () => {
        const res = await PATCH(req({ effective_from: '2025-09-01' }), { params });
        expect(res.status).toBe(400);
    });
});

describe('metered-tariff POST (add historic version)', () => {
    it('400 on a coverage gap', async () => {
        const res = await POST(req({ effective_from: '2022-01-01', seasons: [] }), { params });
        expect(res.status).toBe(400);
        expect(addHistoricMock).not.toHaveBeenCalled();
    });
    it('creates a historic version', async () => {
        const res = await POST(req({ effective_from: '2022-01-01', seasons: fullYearSeasons }), { params });
        expect(res.status).toBe(200);
        expect(addHistoricMock).toHaveBeenCalledWith('s1', expect.objectContaining({ seasons: fullYearSeasons }), '2022-01-01');
    });
    it('400 when effective_from missing (historic versions must be dated)', async () => {
        const res = await POST(req({ seasons: fullYearSeasons }), { params });
        expect(res.status).toBe(400);
    });
});
