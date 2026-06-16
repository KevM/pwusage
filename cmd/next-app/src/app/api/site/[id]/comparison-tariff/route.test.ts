import { beforeEach, describe, expect, it, vi } from 'vitest';

const { verifyMock, saveMock, getMock, renameMock, delVersionMock, delPlanMock, meteredMock, compMock } = vi.hoisted(() => ({
    verifyMock: vi.fn(), saveMock: vi.fn(), getMock: vi.fn(), renameMock: vi.fn(),
    delVersionMock: vi.fn(), delPlanMock: vi.fn(), meteredMock: vi.fn(), compMock: vi.fn(),
}));

vi.mock('@/lib/auth-checks', () => ({ verifySiteAccess: verifyMock }));
vi.mock('@/lib/roi/comparison-tariff-repo', () => ({
    ComparisonTariffRepo: class {
        saveComparisonStructure = saveMock;
        getPlanStructure = getMock;
        renameComparisonPlan = renameMock;
        deleteComparisonVersion = delVersionMock;
        deleteComparisonPlan = delPlanMock;
        nameInUseByMetered = meteredMock;
        comparisonNameInUse = compMock;
    },
}));

import { GET, POST, PATCH, DELETE } from './route';

function req(body?: unknown, url = 'http://x/api/site/site-1/comparison-tariff') {
    return { json: async () => body, url } as unknown as Request;
}
const ctx = { params: Promise.resolve({ id: 'site-1' }) };

// One all-year season with a single 24/7 window — full coverage.
const flatSeasons = [{
    name: 'All Year', from_month: 1, from_day: 1, to_month: 12, to_day: 31, buy_rate: 0, sell_rate: 0,
    schedules: [{ name: 'Flat', buy_rate: 0.2, sell_rate: 0.05, from_day_of_week: 0, to_day_of_week: 6, from_hour: 0, from_minute: 0, to_hour: 24, to_minute: 0 }],
}];
// A season with an obvious gap (only Mon-Fri 16-21).
const gappySeasons = [{
    name: 'All Year', from_month: 1, from_day: 1, to_month: 12, to_day: 31, buy_rate: 0, sell_rate: 0,
    schedules: [{ name: 'Peak', buy_rate: 0.45, sell_rate: 0.06, from_day_of_week: 0, to_day_of_week: 4, from_hour: 16, from_minute: 0, to_hour: 21, to_minute: 0 }],
}];

describe('comparison-tariff route', () => {
    beforeEach(() => {
        for (const m of [verifyMock, saveMock, getMock, renameMock, delVersionMock, delPlanMock, meteredMock, compMock]) m.mockReset();
        verifyMock.mockResolvedValue(true);
        meteredMock.mockResolvedValue(false);
        compMock.mockResolvedValue(false);
    });

    it('GET returns the version structure', async () => {
        getMock.mockResolvedValue({ name: 'EV', seasons: flatSeasons });
        const res = await GET(req(undefined, 'http://x/api/site/site-1/comparison-tariff?name=EV&version=2') as never, ctx as never);
        expect(res.status).toBe(200);
        expect(getMock).toHaveBeenCalledWith('site-1', 'EV', 2);
    });

    it('POST create persists a full structure', async () => {
        const res = await POST(req({ name: 'EV', effective_from: '2025-01-01', seasons: flatSeasons }) as never, ctx as never);
        expect(res.status).toBe(200);
        expect(saveMock).toHaveBeenCalledWith('site-1', 'EV', '2025-01-01', flatSeasons, 'create', undefined);
    });

    it('POST 400 when the structure has a coverage gap', async () => {
        const res = await POST(req({ name: 'EV', seasons: gappySeasons }) as never, ctx as never);
        expect(res.status).toBe(400);
        expect(saveMock).not.toHaveBeenCalled();
    });

    it('POST 409 on metered-name collision', async () => {
        meteredMock.mockResolvedValue(true);
        const res = await POST(req({ name: 'Standard', seasons: flatSeasons }) as never, ctx as never);
        expect(res.status).toBe(409);
    });

    it('POST create 409 when the comparison name already exists', async () => {
        compMock.mockResolvedValue(true);
        const res = await POST(req({ name: 'EV', seasons: flatSeasons }) as never, ctx as never);
        expect(res.status).toBe(409);
    });

    it('POST append-version skips the comparison-name check', async () => {
        compMock.mockResolvedValue(true);
        const res = await POST(req({ intent: 'append-version', name: 'EV', seasons: flatSeasons }) as never, ctx as never);
        expect(res.status).toBe(200);
        expect(saveMock).toHaveBeenCalledWith('site-1', 'EV', null, flatSeasons, 'append-version', undefined);
    });

    it('PATCH replace persists with the version', async () => {
        const res = await PATCH(req({ name: 'EV', version: 2, effective_from: '2025-06-01', seasons: flatSeasons }) as never, ctx as never);
        expect(res.status).toBe(200);
        expect(saveMock).toHaveBeenCalledWith('site-1', 'EV', '2025-06-01', flatSeasons, 'replace', 2);
    });

    it('PATCH replace 400 on a coverage gap', async () => {
        const res = await PATCH(req({ name: 'EV', version: 2, seasons: gappySeasons }) as never, ctx as never);
        expect(res.status).toBe(400);
        expect(saveMock).not.toHaveBeenCalled();
    });

    it('PATCH rename calls renameComparisonPlan after the guards', async () => {
        const res = await PATCH(req({ intent: 'rename', name: 'EV', newName: 'EV Plan' }) as never, ctx as never);
        expect(res.status).toBe(200);
        expect(renameMock).toHaveBeenCalledWith('site-1', 'EV', 'EV Plan');
    });

    it('PATCH rename 409 when the new name collides', async () => {
        compMock.mockResolvedValue(true);
        const res = await PATCH(req({ intent: 'rename', name: 'EV', newName: 'Taken' }) as never, ctx as never);
        expect(res.status).toBe(409);
        expect(renameMock).not.toHaveBeenCalled();
    });

    it('DELETE with a version removes that version', async () => {
        const res = await DELETE(req({ name: 'EV', version: 1 }) as never, ctx as never);
        expect(res.status).toBe(200);
        expect(delVersionMock).toHaveBeenCalledWith('site-1', 'EV', 1);
    });

    it('DELETE without a version removes the whole plan', async () => {
        const res = await DELETE(req({ name: 'EV' }) as never, ctx as never);
        expect(res.status).toBe(200);
        expect(delPlanMock).toHaveBeenCalledWith('site-1', 'EV');
    });

    it('POST 403 when unauthorized', async () => {
        verifyMock.mockResolvedValue(false);
        const res = await POST(req({ name: 'EV', seasons: flatSeasons }) as never, ctx as never);
        expect(res.status).toBe(403);
    });
});
