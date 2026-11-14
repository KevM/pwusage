import { beforeEach, describe, expect, it, vi } from 'vitest';

const { verifyAccessMock, logEventMock } = vi.hoisted(() => ({
    verifyAccessMock: vi.fn(),
    logEventMock: vi.fn(),
}));

vi.mock('@/lib/auth-checks', () => ({ verifySiteAccess: verifyAccessMock }));
vi.mock('@/lib/observability', () => ({ logEvent: logEventMock }));

import { POST } from './route';

function makeRequest(body: unknown, contentType = 'application/json'): Request {
    return new Request('https://example.test/api/mobile/bill-shadow', {
        method: 'POST',
        headers: { 'Content-Type': contentType },
        body: typeof body === 'string' ? body : JSON.stringify(body),
    });
}

const validReport = {
    siteId: 'site-a',
    appBuild: '42',
    cycleStart: '2026-10-01T07:00:00.000Z',
    server: {
        estimatedCost: 12.34,
        periods: [{ tariffName: 'TOU-D', periodName: 'Peak', cost: 12.34 }],
    },
    local: {
        estimatedCost: 12.5,
        periods: [{ tariffName: 'TOU-D', periodName: 'Peak', cost: 12.5 }],
    },
    reattributionRunning: false,
};

describe('POST /api/mobile/bill-shadow', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        verifyAccessMock.mockResolvedValue(true);
    });

    it('logs a valid report and answers 204', async () => {
        const response = await POST(makeRequest(validReport));

        expect(response.status).toBe(204);
        expect(await response.text()).toBe('');
        expect(verifyAccessMock).toHaveBeenCalledWith('site-a');
        expect(logEventMock).toHaveBeenCalledTimes(1);
        expect(logEventMock).toHaveBeenCalledWith('warn', 'mobile.bill-shadow.mismatch', {
            siteId: 'site-a',
            appBuild: '42',
            cycleStart: '2026-10-01T07:00:00.000Z',
            reattributionRunning: false,
            serverEstimatedCost: 12.34,
            localEstimatedCost: 12.5,
            estimatedCostDiff: expect.closeTo(0.16, 9),
            periodDiffs: [
                {
                    tariffName: 'TOU-D',
                    periodName: 'Peak',
                    serverCost: 12.34,
                    localCost: 12.5,
                    diff: expect.closeTo(0.16, 9),
                },
            ],
        });
    });

    it('rejects non-finite amounts', async () => {
        const rawWithInfinity = JSON.stringify(validReport).replace('12.5', '1e309');
        const infinityResponse = await POST(makeRequest(rawWithInfinity));
        expect(infinityResponse.status).toBe(400);

        const stringCostResponse = await POST(makeRequest({
            ...validReport,
            local: {
                estimatedCost: 'NaN',
                periods: [{ tariffName: 'TOU-D', periodName: 'Peak', cost: 12.5 }],
            },
        }));
        expect(stringCostResponse.status).toBe(400);

        const nonFinitePeriodResponse = await POST(makeRequest({
            ...validReport,
            server: {
                estimatedCost: 10,
                periods: [{ tariffName: 'TOU-D', periodName: 'Peak', cost: 'Infinity' }],
            },
        }));
        expect(nonFinitePeriodResponse.status).toBe(400);
    });

    it('rejects unauthorised sites', async () => {
        verifyAccessMock.mockResolvedValue(false);
        const response = await POST(makeRequest(validReport));
        expect(response.status).toBe(401);
    });

    it('rejects bodies over 16 KB', async () => {
        const hugePeriodName = 'x'.repeat(17 * 1024);
        const response = await POST(makeRequest({
            ...validReport,
            server: {
                estimatedCost: 1,
                periods: [{ tariffName: 'TOU-D', periodName: hugePeriodName, cost: 1 }],
            },
        }));
        expect(response.status).toBe(400);
    });
});
