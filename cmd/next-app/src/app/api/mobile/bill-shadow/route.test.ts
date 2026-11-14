import { beforeEach, describe, expect, it, vi } from 'vitest';

const { verifyAccessMock, logEventMock, getSiteMock, rawEnergyMock } = vi.hoisted(() => ({
    verifyAccessMock: vi.fn(),
    logEventMock: vi.fn(),
    getSiteMock: vi.fn(),
    rawEnergyMock: vi.fn(),
}));

vi.mock('@/lib/auth-checks', () => ({ verifySiteAccess: verifyAccessMock }));
vi.mock('@/lib/observability', () => ({ logEvent: logEventMock }));
vi.mock('@/lib/site-repo', () => ({ SiteRepo: vi.fn(function SiteRepo() { return { getSite: getSiteMock }; }) }));
vi.mock('@/lib/energy-repo-factory', () => ({ createEnergyRepo: () => ({ getRawEnergyData: rawEnergyMock }) }));

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
        getSiteMock.mockResolvedValue({ id: 'site-a', timezone: 'America/Chicago' });
        rawEnergyMock.mockResolvedValue([]);
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

    it('logs the days where the phone and server disagree when the phone sends its days', async () => {
        rawEnergyMock.mockResolvedValue([
            { timestamp: new Date('2026-11-14T05:55:00Z'), grid_power: 3935 },
            { timestamp: new Date('2026-11-14T06:00:00Z'), grid_power: 500 },
            { timestamp: new Date('2026-11-14T16:40:00Z'), grid_power: 480 },
        ]);
        const response = await POST(makeRequest({
            ...validReport,
            cycleStart: '2026-11-11T06:00:00.000Z',
            localDays: [
                { day: '2026-11-13', gridWh: 3935, last: '2026-11-14T05:55:00.000Z' },
                { day: '2026-11-14', gridWh: 2.4, last: '2026-11-14T06:00:00.000Z' },
            ],
        }));

        expect(response.status).toBe(204);
        expect(getSiteMock).toHaveBeenCalledWith('site-a');
        expect(rawEnergyMock).toHaveBeenCalledWith('site-a', new Date('2026-11-11T06:00:00.000Z'), expect.any(Date));
        expect(logEventMock.mock.calls[0][2]).toMatchObject({
            dayDiffs: [{
                day: '2026-11-14',
                serverGridWh: 980,
                localGridWh: 2.4,
                serverLast: '2026-11-14T16:40:00.000Z',
                localLast: '2026-11-14T06:00:00.000Z',
            }],
        });
    });

    it('still logs the report when the server days cannot be read', async () => {
        rawEnergyMock.mockRejectedValue(new Error('archive unavailable'));
        const response = await POST(makeRequest({
            ...validReport,
            localDays: [{ day: '2026-10-01', gridWh: 1 }],
        }));

        expect(response.status).toBe(204);
        expect(logEventMock.mock.calls[0][2]).toMatchObject({ dayDiffs: null, dayDiffsError: 'archive unavailable' });
    });

    it('rejects malformed local days', async () => {
        for (const localDays of [
            'nope',
            [{ day: '2026-11-14', gridWh: 'x', last: null }],
            [{ day: 'today', gridWh: 1, last: null }],
            [{ day: '2026-11-14', gridWh: 1, last: 'not a date' }],
            Array.from({ length: 41 }, () => ({ day: '2026-11-14', gridWh: 1, last: null })),
        ]) {
            const response = await POST(makeRequest({ ...validReport, localDays }));
            expect(response.status).toBe(400);
        }
    });
});
