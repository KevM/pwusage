import { describe, expect, it, vi } from 'vitest';
import {
    TeslaTokenEndpointError,
    postToTeslaTokenEndpoint,
} from './tesla-token-endpoint';

const FLEET_AUTH = 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token';
const AUTH_TESLA = 'https://auth.tesla.com/oauth2/v3/token';

function okResponse(): Response {
    return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }),
    } as unknown as Response;
}

describe('postToTeslaTokenEndpoint', () => {
    it('posts form-encoded body to the documented fleet-auth host first', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(okResponse());

        const { host } = await postToTeslaTokenEndpoint({ grant_type: 'authorization_code' }, fetchImpl);

        expect(host).toBe('https://fleet-auth.prd.vn.cloud.tesla.com');
        expect(fetchImpl).toHaveBeenCalledTimes(1);

        const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
        expect(url).toBe(FLEET_AUTH);
        expect((init.headers as Record<string, string>)['Content-Type'])
            .toBe('application/x-www-form-urlencoded');
        expect(String(init.body)).toBe('grant_type=authorization_code');
    });

    it('sets a per-attempt timeout so a blackholed primary host cannot strand the fallback', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(okResponse());

        await postToTeslaTokenEndpoint({ code: 'x' }, fetchImpl);

        const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
        expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it('falls back to auth.tesla.com on a 5xx, resending the identical body', async () => {
        const fetchImpl = vi
            .fn()
            .mockResolvedValueOnce({ ok: false, status: 503 } as unknown as Response)
            .mockResolvedValueOnce(okResponse());

        const { host } = await postToTeslaTokenEndpoint({ grant_type: 'refresh_token' }, fetchImpl);

        expect(host).toBe('https://auth.tesla.com');
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect((fetchImpl.mock.calls[1] as [string, unknown])[0]).toBe(AUTH_TESLA);
        // The reused URLSearchParams body must still carry the parameters on the
        // retry; asserting only the URL would not catch a corrupted second send.
        expect(String((fetchImpl.mock.calls[1] as [string, RequestInit])[1].body))
            .toBe('grant_type=refresh_token');
    });

    it('falls back to auth.tesla.com when the primary host throws a network error', async () => {
        const fetchImpl = vi
            .fn()
            .mockRejectedValueOnce(new Error('ECONNRESET'))
            .mockResolvedValueOnce(okResponse());

        const { host } = await postToTeslaTokenEndpoint({ grant_type: 'refresh_token' }, fetchImpl);

        expect(host).toBe('https://auth.tesla.com');
    });

    // Table-driven across the 4xx statuses that matter. The upper bound is the
    // load-bearing part: narrowing the guard to e.g. `status < 429` would make a
    // Tesla rate-limit response trigger a fallback and re-send client_secret to
    // a second origin, which is precisely what this design prevents.
    // tesla-client.ts already handles 429 elsewhere, so that edit is plausible.
    it.each([400, 401, 403, 429])(
        'does NOT fall back on %i, which is a real authentication failure',
        async (status) => {
            const fetchImpl = vi
                .fn()
                .mockResolvedValue({ ok: false, status } as unknown as Response);

            const { response, host } = await postToTeslaTokenEndpoint({ code: 'x' }, fetchImpl);

            expect(response.status).toBe(status);
            expect(host).toBe('https://fleet-auth.prd.vn.cloud.tesla.com');
            expect(fetchImpl).toHaveBeenCalledTimes(1);
        }
    );

    it('does not re-send the secret to a second host on a 3xx redirect response', async () => {
        const fetchImpl = vi
            .fn()
            .mockResolvedValue({ ok: false, status: 302 } as unknown as Response);

        await expect(postToTeslaTokenEndpoint({ code: 'x' }, fetchImpl))
            .rejects.toBeInstanceOf(TeslaTokenEndpointError);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    // A Tesla-side redirect reaches the user as an unexplained login failure, and
    // the thrown message only lands in the logs if the framework reports an
    // unhandled route error. Without this the status and host are never recorded.
    it('logs the status and host when the response is an unexpected non-2xx/4xx/5xx', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const fetchImpl = vi
            .fn()
            .mockResolvedValue({ ok: false, status: 307 } as unknown as Response);

        try {
            await expect(postToTeslaTokenEndpoint({ code: 'x' }, fetchImpl))
                .rejects.toBeInstanceOf(TeslaTokenEndpointError);

            expect(warn).toHaveBeenCalledWith(expect.stringContaining('307'));
            expect(warn).toHaveBeenCalledWith(expect.stringContaining(FLEET_AUTH.replace('/oauth2/v3/token', '')));
        } finally {
            warn.mockRestore();
        }
    });

    // A mocked fetchImpl cannot follow or refuse a redirect — it is handed
    // whatever Response the test invents — so this asserts the *request option*
    // that makes undici surface a 3xx instead of re-POSTing the body to the
    // redirect target. A 307/308 preserves method and body, so without 'manual'
    // the target receives client_secret. Verified against a real local server
    // (the default delivered the whole form body to the redirect target; 'manual'
    // delivered nothing), but that experiment is not reproducible here: the
    // endpoint hosts are a module-private constant with no override, so the URL
    // under test cannot be pointed at a test server. This assertion is therefore
    // the strongest check available without an integration server.
    it('asks fetch not to follow redirects, so client_secret is never re-POSTed to a redirect target', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(okResponse());

        await postToTeslaTokenEndpoint({ client_secret: 'shh' }, fetchImpl);

        const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
        expect(init.redirect).toBe('manual');
    });

    it('carries the last HTTP status when every host responds 5xx', async () => {
        const fetchImpl = vi
            .fn()
            .mockResolvedValue({ ok: false, status: 503 } as unknown as Response);

        await expect(postToTeslaTokenEndpoint({ code: 'x' }, fetchImpl))
            .rejects.toMatchObject({ name: 'TeslaTokenEndpointError', status: 503 });
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('reports a null status when every host fails at the network level', async () => {
        const fetchImpl = vi.fn().mockRejectedValue(new Error('ENOTFOUND'));

        await expect(postToTeslaTokenEndpoint({ code: 'x' }, fetchImpl))
            .rejects.toMatchObject({ name: 'TeslaTokenEndpointError', status: null });
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('names the actual failure reason instead of reporting null', async () => {
        const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 502 } as unknown as Response);

        await expect(postToTeslaTokenEndpoint({ code: 'x' }, fetchImpl))
            .rejects.toThrow(/HTTP 502/);
    });

    // A transport failure is never a credential failure. isTeslaAuthError matches
    // message substrings, so folding a fetch error or its cause into the thrown
    // message can make a dead socket look like a revoked refresh token.
    it('keeps transport error text out of the thrown message', async () => {
        const transportError = new Error('fetch failed: invalid authentication', {
            cause: new Error('proxy returned invalid_grant'),
        });
        const fetchImpl = vi.fn().mockRejectedValue(transportError);

        const thrown = await postToTeslaTokenEndpoint({ code: 'x' }, fetchImpl)
            .catch((err: unknown) => err);

        expect(thrown).toBeInstanceOf(TeslaTokenEndpointError);
        expect((thrown as Error).message).not.toMatch(/login_required|invalid_grant|invalid authentication/i);
    });

    // ReadableStream.cancel() rejects on an already-errored stream. Without a
    // catch this surfaces as an unhandled rejection, i.e. a 500 where a clean
    // 502 was intended — precisely the flapping-upstream case this branch
    // exists to survive.
    it('does not leak an unhandled rejection when discarding an errored body', async () => {
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown) => unhandled.push(reason);
        process.on('unhandledRejection', onUnhandled);

        const fetchImpl = vi
            .fn()
            .mockResolvedValue({
                ok: false,
                status: 503,
                body: { cancel: () => Promise.reject(new Error('stream already errored')) },
            } as unknown as Response);

        try {
            await expect(postToTeslaTokenEndpoint({ code: 'x' }, fetchImpl))
                .rejects.toBeInstanceOf(TeslaTokenEndpointError);
            // Give Node a macrotask turn to detect any unhandled rejection.
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(unhandled).toEqual([]);
        } finally {
            process.off('unhandledRejection', onUnhandled);
        }
    });

    // A mixed failure must not report a 5xx status for a network failure, or
    // Task 6 will hand the callback a 503 for what was actually a dead socket.
    it('reports a null status when the last host fails at the network level after a 5xx', async () => {
        const fetchImpl = vi
            .fn()
            .mockResolvedValueOnce({ ok: false, status: 503 } as unknown as Response)
            .mockRejectedValueOnce(new Error('ECONNRESET'));

        await expect(postToTeslaTokenEndpoint({ code: 'x' }, fetchImpl))
            .rejects.toMatchObject({ status: null });
    });
});
