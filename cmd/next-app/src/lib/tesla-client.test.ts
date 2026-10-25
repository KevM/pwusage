import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TeslaClient, TeslaAuthError, isTeslaAuthError } from './tesla-client';

function makeJsonResponse<T>(payload: T): Response {
    return {
        ok: true,
        status: 200,
        json: async () => payload,
        text: async () => JSON.stringify(payload),
    } as unknown as Response;
}

function make429Response(retryAfter?: string): Response {
    const headers = new Headers();
    if (retryAfter !== undefined) headers.set('Retry-After', retryAfter);
    return {
        ok: false,
        status: 429,
        headers,
        json: async () => ({}),
        text: async () => 'rate limited',
    } as unknown as Response;
}

function make401Response(): Response {
    return {
        ok: false,
        status: 401,
        headers: new Headers(),
        json: async () => ({}),
        text: async () => 'unauthorized',
    } as unknown as Response;
}

describe('TeslaClient rate limiting (429)', () => {
    beforeEach(() => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('retries after a 429, waiting the Retry-After interval, then returns the result', async () => {
        vi.useFakeTimers();
        const fetchMock = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(make429Response('1'))
            .mockResolvedValueOnce(makeJsonResponse({ response: [], count: 0 }));

        const client = new TeslaClient({ accessToken: 'tok' });
        const promise = client.getProducts();

        await vi.advanceTimersByTimeAsync(1000);
        const result = await promise;

        expect(result).toEqual([]);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('refreshes the token when a 429 retry returns 401, then succeeds', async () => {
        vi.useFakeTimers();
        const fetchMock = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(make429Response('1'))                        // initial -> 429
            .mockResolvedValueOnce(make401Response())                          // retry after backoff -> 401
            .mockResolvedValueOnce(makeJsonResponse({ response: [], count: 0 })); // retry after refresh -> 200

        const tokenRefreshHandler = vi.fn().mockResolvedValue({
            access_token: 'new-access',
            refresh_token: 'new-refresh',
        });
        const onTokenUpdate = vi.fn();

        const client = new TeslaClient({
            accessToken: 'tok',
            refreshToken: 'refresh-tok',
            tokenRefreshHandler,
            onTokenUpdate,
        });
        const promise = client.getProducts();

        await vi.advanceTimersByTimeAsync(1000);
        const result = await promise;

        expect(result).toEqual([]);
        expect(tokenRefreshHandler).toHaveBeenCalledWith('refresh-tok');
        expect(onTokenUpdate).toHaveBeenCalledWith('new-access', 'new-refresh');
        expect(fetchMock).toHaveBeenCalledTimes(3);

        // The final request must use the refreshed access token.
        const lastCall = fetchMock.mock.calls[2] as [string, RequestInit];
        const headers = lastCall[1].headers as Record<string, string>;
        expect(headers.Authorization).toBe('Bearer new-access');
    });

    it('surfaces the error when refresh fails on a 401 after a 429 retry', async () => {
        vi.useFakeTimers();
        const fetchMock = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(make429Response('1')) // initial -> 429
            .mockResolvedValueOnce(make401Response());   // retry after backoff -> 401

        const tokenRefreshHandler = vi.fn().mockRejectedValue(new Error('refresh boom'));
        const onTokenError = vi.fn();

        const client = new TeslaClient({
            accessToken: 'tok',
            refreshToken: 'refresh-tok',
            tokenRefreshHandler,
            onTokenError,
        });
        const promise = client.getProducts();
        const assertion = expect(promise).rejects.toThrow(/401/);

        await vi.advanceTimersByTimeAsync(1000);
        await assertion;

        expect(tokenRefreshHandler).toHaveBeenCalledTimes(1);
        expect(onTokenError).toHaveBeenCalledTimes(1);
        // initial + one 429 retry; refresh failure stops further requests
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('throws after exhausting retries when 429 persists', async () => {
        vi.useFakeTimers();
        const fetchMock = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValue(make429Response('0'));

        const client = new TeslaClient({ accessToken: 'tok' });
        const promise = client.getProducts();
        const assertion = expect(promise).rejects.toThrow(/429/);

        await vi.advanceTimersByTimeAsync(60_000);
        await assertion;

        // 1 initial attempt + 2 retries
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });
});

describe('TeslaClient.getSoeHistory', () => {
    beforeEach(() => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

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

// Shapes observed from Tesla (Harrison, 2026-10-25): a day with no data answers
// energy with an empty serial_number and no time_series, and SOE with "".
const EMPTY_DAY_ENERGY = { response: { serial_number: '', period: 'day', SmartBreakerEnergyLogs: null } };
const EMPTY_DAY_SOE = { response: '' };

describe('TeslaClient calendar_history response validation', () => {
    const start = new Date('2026-02-16T06:00:00.000Z');
    const end = new Date('2026-02-17T05:59:59.000Z');
    const client = () => new TeslaClient({ accessToken: 'test-access-token' });
    const answer = (payload: unknown) => vi.spyOn(globalThis, 'fetch').mockResolvedValue(makeJsonResponse(payload));

    beforeEach(() => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('treats Tesla\'s no-data day answers as empty', async () => {
        answer(EMPTY_DAY_ENERGY);
        await expect(client().getEnergyHistory('1', start, end, 'day', 'America/Chicago')).resolves.toEqual([]);
        vi.restoreAllMocks();
        vi.spyOn(console, 'log').mockImplementation(() => {});
        answer(EMPTY_DAY_SOE);
        await expect(client().getSoeHistory('1', start, end, 'day', 'America/Chicago')).resolves.toEqual([]);
    });

    it('keeps an explicit empty time_series as empty', async () => {
        answer({ response: { serial_number: 'X', time_series: [] } });
        await expect(client().getEnergyHistory('1', start, end, 'day', 'America/Chicago')).resolves.toEqual([]);
        await expect(client().getSoeHistory('1', start, end, 'day', 'America/Chicago')).resolves.toEqual([]);
    });

    it.each([
        ['no response', {}],
        ['an empty response object', { response: {} }],
        ['a site serial without time_series', { response: { serial_number: 'X', period: 'day' } }],
        ['a non-array time_series', { response: { serial_number: 'X', time_series: null } }],
        ['a string response', { response: 'oops' }],
    ])('rejects an energy answer with %s', async (_label, payload) => {
        answer(payload);
        await expect(client().getEnergyHistory('1', start, end, 'day', 'America/Chicago')).rejects.toThrow(/Malformed Tesla energy history/);
    });

    it.each([
        ['no response', {}],
        ['an empty response object', { response: {} }],
        ['the energy no-data shape', EMPTY_DAY_ENERGY],
        ['a non-array time_series', { response: { serial_number: 'X', time_series: {} } }],
        ['a non-empty string response', { response: 'oops' }],
    ])('rejects an SOE answer with %s', async (_label, payload) => {
        answer(payload);
        await expect(client().getSoeHistory('1', start, end, 'day', 'America/Chicago')).rejects.toThrow(/Malformed Tesla SOE history/);
    });
});

describe('TeslaClient.setBackupReserve', () => {
    beforeEach(() => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('POSTs backup_reserve_percent to the energy site backup endpoint and returns the command response', async () => {
        // Shape mirrors the live Tesla response observed against a real site:
        // PascalCase keys, Code 200 (not the lowercase { code, message } in some docs).
        const fetchMock = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValue(makeJsonResponse({ response: { Code: 200, Message: 'Backup reserve updated' } }));

        const client = new TeslaClient({ accessToken: 'test-access-token' });
        const siteId = '2252268092126997';

        const result = await client.setBackupReserve(siteId, 30);

        expect(result).toEqual({ Code: 200, Message: 'Backup reserve updated' });
        expect(fetchMock).toHaveBeenCalledTimes(1);

        const [requestUrl, options] = fetchMock.mock.calls[0] as [string, RequestInit];
        const parsed = new URL(requestUrl);
        expect(parsed.pathname).toBe(`/api/1/energy_sites/${siteId}/backup`);
        expect(options.method).toBe('POST');
        expect(JSON.parse(options.body as string)).toEqual({ backup_reserve_percent: 30 });

        const headers = options.headers as Record<string, string>;
        expect(headers.Authorization).toBe('Bearer test-access-token');
        expect(headers['Content-Type']).toBe('application/json');
    });

    it('rejects an invalid reserve percent without calling the API', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch');
        const client = new TeslaClient({ accessToken: 'tok' });

        await expect(client.setBackupReserve('site', 150)).rejects.toThrow(/between 0 and 100/);
        await expect(client.setBackupReserve('site', -5)).rejects.toThrow(/between 0 and 100/);
        await expect(client.setBackupReserve('site', 42.5)).rejects.toThrow(/integer/);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

function make403Response(): Response {
    return {
        ok: false,
        status: 403,
        headers: new Headers(),
        json: async () => ({}),
        text: async () => 'forbidden',
    } as unknown as Response;
}

describe('TeslaClient authentication errors', () => {
    beforeEach(() => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('throws TeslaAuthError on HTTP 401 response', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(make401Response());
        const client = new TeslaClient({ accessToken: 'tok' });

        let thrownError: unknown;
        try {
            await client.getProducts();
        } catch (err) {
            thrownError = err;
        }

        expect(thrownError).toBeInstanceOf(TeslaAuthError);
        expect((thrownError as TeslaAuthError).status).toBe(401);
        expect(isTeslaAuthError(thrownError)).toBe(true);
    });

    it('throws TeslaAuthError on HTTP 403 response', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(make403Response());
        const client = new TeslaClient({ accessToken: 'tok' });

        let thrownError: unknown;
        try {
            await client.getProducts();
        } catch (err) {
            thrownError = err;
        }

        expect(thrownError).toBeInstanceOf(TeslaAuthError);
        expect((thrownError as TeslaAuthError).status).toBe(403);
        expect(isTeslaAuthError(thrownError)).toBe(true);
    });

    it('identifies standard strings with 401 or login_required as isTeslaAuthError', () => {
        expect(isTeslaAuthError(new Error('Tesla API Error: 401 Unauthorized'))).toBe(true);
        expect(isTeslaAuthError(new Error('login_required'))).toBe(true);
        expect(isTeslaAuthError(new Error('some random error'))).toBe(false);
    });
});
