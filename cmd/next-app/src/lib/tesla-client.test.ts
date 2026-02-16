import { afterEach, describe, expect, it, vi } from 'vitest';
import { TeslaClient } from './tesla-client';

function makeJsonResponse<T>(payload: T): Response {
    return {
        ok: true,
        status: 200,
        json: async () => payload,
        text: async () => JSON.stringify(payload),
    } as unknown as Response;
}

describe('TeslaClient.getSoeHistory', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('calls Tesla calendar_history with kind=soe and returns time_series', async () => {
        const fetchMock = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValue(makeJsonResponse({
                response: {
                    time_series: [
                        { timestamp: '2026-02-16T00:00:00-06:00', soe: 52 },
                        { timestamp: '2026-02-16T00:05:00-06:00', percentage_charged: 53 },
                    ],
                },
            }));

        const client = new TeslaClient({ accessToken: 'test-access-token' });
        const siteId = '2252268092126997';
        const start = new Date('2026-02-16T06:00:00.000Z');
        const end = new Date('2026-02-16T15:06:03.000Z');

        const rows = await client.getSoeHistory(siteId, start, end, 'day', 'America/Chicago');

        expect(rows).toEqual([
            { timestamp: '2026-02-16T00:00:00-06:00', percentage_charged: 52 },
            { timestamp: '2026-02-16T00:05:00-06:00', percentage_charged: 53 },
        ]);
        expect(fetchMock).toHaveBeenCalledTimes(1);

        const [requestUrl, options] = fetchMock.mock.calls[0] as [string, RequestInit];
        const parsed = new URL(requestUrl);
        expect(parsed.pathname).toBe(`/api/1/energy_sites/${siteId}/calendar_history`);
        expect(parsed.searchParams.get('kind')).toBe('soe');
        expect(parsed.searchParams.get('period')).toBe('day');
        expect(parsed.searchParams.get('time_zone')).toBe('America/Chicago');
        expect(parsed.searchParams.get('start_date')).toMatch(/^2026-02-16T00:00:00-06:00$/);
        expect(parsed.searchParams.get('end_date')).toMatch(/^2026-02-16T09:06:03-06:00$/);

        const headers = options.headers as Record<string, string>;
        expect(headers.Authorization).toBe('Bearer test-access-token');
    });
});
