import { beforeEach, describe, expect, it, vi } from 'vitest';

const { verifyMock, appendMock, editMock, delVersionMock, delPlanMock, meteredMock, compMock } = vi.hoisted(() => ({
    verifyMock: vi.fn(), appendMock: vi.fn(), editMock: vi.fn(),
    delVersionMock: vi.fn(), delPlanMock: vi.fn(), meteredMock: vi.fn(), compMock: vi.fn(),
}));

vi.mock('@/lib/auth-checks', () => ({ verifySiteAccess: verifyMock }));
vi.mock('@/lib/roi/comparison-tariff-repo', () => ({
    ComparisonTariffRepo: class {
        appendFixedComparison = appendMock;
        editComparisonVersion = editMock;
        deleteComparisonVersion = delVersionMock;
        deleteComparisonPlan = delPlanMock;
        nameInUseByMetered = meteredMock;
        comparisonNameInUse = compMock;
    },
}));

import { POST, PATCH, DELETE } from './route';

function req(body?: unknown) { return { json: async () => body } as unknown as Request; }
const ctx = { params: Promise.resolve({ id: 'site-1' }) };

describe('comparison-tariff route', () => {
    beforeEach(() => {
        verifyMock.mockReset(); appendMock.mockReset(); editMock.mockReset();
        delVersionMock.mockReset(); delPlanMock.mockReset(); meteredMock.mockReset(); compMock.mockReset();
        verifyMock.mockResolvedValue(true);
        meteredMock.mockResolvedValue(false);
        compMock.mockResolvedValue(false);
    });

    it('POST 403 when unauthorized', async () => {
        verifyMock.mockResolvedValue(false);
        const res = await POST(req({ name: 'X', buy_rate: 0.1, sell_rate: 0 }) as never, ctx as never);
        expect(res.status).toBe(403);
    });

    it('POST create appends and returns success', async () => {
        const res = await POST(req({ name: 'EV', buy_rate: 0.3, sell_rate: 0.05, effective_from: '2025-01-01' }) as never, ctx as never);
        expect(res.status).toBe(200);
        expect(appendMock).toHaveBeenCalled();
    });

    it('POST create 409 when the name is an existing comparison plan', async () => {
        compMock.mockResolvedValue(true);
        const res = await POST(req({ name: 'EV', buy_rate: 0.3, sell_rate: 0 }) as never, ctx as never);
        expect(res.status).toBe(409);
        expect(appendMock).not.toHaveBeenCalled();
    });

    it('POST append-version skips the comparison-name check and appends', async () => {
        compMock.mockResolvedValue(true);
        const res = await POST(req({ intent: 'append-version', name: 'EV', buy_rate: 0.3, sell_rate: 0 }) as never, ctx as never);
        expect(res.status).toBe(200);
        expect(appendMock).toHaveBeenCalled();
    });

    it('POST 400 when buy_rate or sell_rate is empty/blank', async () => {
        const res = await POST(req({ name: 'EV', buy_rate: '', sell_rate: 0.1 }) as never, ctx as never);
        expect(res.status).toBe(400);
        const res2 = await POST(req({ name: 'EV', buy_rate: 0.1, sell_rate: '   ' }) as never, ctx as never);
        expect(res2.status).toBe(400);
    });

    it('POST 409 when the name collides with the metered plan', async () => {
        meteredMock.mockResolvedValue(true);
        const res = await POST(req({ name: 'Standard', buy_rate: 0.3, sell_rate: 0 }) as never, ctx as never);
        expect(res.status).toBe(409);
    });

    it('PATCH edits a version', async () => {
        const res = await PATCH(req({ name: 'EV', version: 2, buy_rate: 0.31, sell_rate: 0.06, effective_from: '2025-06-01' }) as never, ctx as never);
        expect(res.status).toBe(200);
        expect(editMock).toHaveBeenCalledWith('site-1', 'EV', 2, { buyRate: 0.31, sellRate: 0.06, effectiveFrom: '2025-06-01' });
    });

    it('PATCH 400 on a missing/invalid version', async () => {
        const res = await PATCH(req({ name: 'EV', buy_rate: 0.3, sell_rate: 0 }) as never, ctx as never);
        expect(res.status).toBe(400);
        expect(editMock).not.toHaveBeenCalled();
    });

    it('PATCH 400 when buy_rate or sell_rate is empty/blank', async () => {
        const res = await PATCH(req({ name: 'EV', version: 2, buy_rate: '', sell_rate: 0.1 }) as never, ctx as never);
        expect(res.status).toBe(400);
        const res2 = await PATCH(req({ name: 'EV', version: 2, buy_rate: 0.1, sell_rate: '   ' }) as never, ctx as never);
        expect(res2.status).toBe(400);
    });


    it('DELETE with a version removes that version', async () => {
        const res = await DELETE(req({ name: 'EV', version: 1 }) as never, ctx as never);
        expect(res.status).toBe(200);
        expect(delVersionMock).toHaveBeenCalledWith('site-1', 'EV', 1);
        expect(delPlanMock).not.toHaveBeenCalled();
    });

    it('DELETE without a version removes the whole plan', async () => {
        const res = await DELETE(req({ name: 'EV' }) as never, ctx as never);
        expect(res.status).toBe(200);
        expect(delPlanMock).toHaveBeenCalledWith('site-1', 'EV');
        expect(delVersionMock).not.toHaveBeenCalled();
    });

    it('DELETE 400 when the name is missing', async () => {
        const res = await DELETE(req({}) as never, ctx as never);
        expect(res.status).toBe(400);
    });

    it('DELETE 403 when unauthorized', async () => {
        verifyMock.mockResolvedValue(false);
        const res = await DELETE(req({ name: 'EV' }) as never, ctx as never);
        expect(res.status).toBe(403);
    });
});
