import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { logEvent } = vi.hoisted(() => ({ logEvent: vi.fn() }));
vi.mock('./observability', () => ({ logEvent }));
import { refreshAccessToken } from './tesla-auth';
import { withIoDeadline } from './io-deadline';

describe('refresh exchange diagnostics', () => {
    beforeEach(() => {
        vi.stubEnv('PUBLIC_TESLA_OAUTH_CLIENT_ID', 'private-client');
        vi.stubEnv('TESLA_OAUTH_SECRET', 'private-secret');
        logEvent.mockReset();
    });
    afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); vi.restoreAllMocks(); });
    it('correlates request, headers and parsed credentials without exposing credentials', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
            access_token: 'private-access', refresh_token: 'private-replacement',
        }))));
        await refreshAccessToken('private-old');
        const events = logEvent.mock.calls.filter(([, event]) => event.startsWith('tesla.refresh.'));
        expect(events.map(([, event]) => event)).toEqual([
            'tesla.refresh.request-started', 'tesla.refresh.response-received', 'tesla.refresh.credentials-parsed',
        ]);
        const ids = events.map(([, , fields]) => fields.exchangeId);
        expect(ids[0]).toEqual(expect.any(String));
        expect(new Set(ids).size).toBe(1);
        expect(JSON.stringify(events)).not.toContain('private-');
    });
    it.each(['request', 'response-body'])('records deadline cancellation during %s with an uncertain outcome', async stage => {
        vi.useFakeTimers();
        vi.stubGlobal('fetch', vi.fn().mockReturnValue(stage === 'request' ? new Promise<Response>(() => {}) : Promise.resolve({
            ok: true, status: 200, json: () => new Promise<unknown>(() => {}),
        })));
        const result = withIoDeadline(50, () => refreshAccessToken('private-old')).catch(error => error);
        await vi.advanceTimersByTimeAsync(50);
        expect(await result).toMatchObject({ code: 'IO_DEADLINE_EXCEEDED' });
        expect(logEvent).toHaveBeenCalledWith('warn', 'tesla.refresh.exchange-failed', expect.objectContaining({
            stage, cancellationSource: 'caller', failureCode: 'IO_DEADLINE_EXCEEDED', outcomeUnknown: true,
            exchangeId: expect.any(String),
        }));
        expect(logEvent.mock.calls.some(([, event]) => event === 'tesla.refresh.credentials-parsed')).toBe(false);
        expect(JSON.stringify(logEvent.mock.calls)).not.toContain('private-');
    });
    it('distinguishes endpoint timeout and preserves the caller context across host fallback', async () => {
        const timeout = new AbortController();
        vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
        const fetchMock = vi.fn().mockImplementationOnce(() => {
            timeout.abort(new DOMException('private-error', 'TimeoutError'));
            return Promise.reject(timeout.signal.reason);
        }).mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'private-access', refresh_token: 'private-new' })));
        vi.stubGlobal('fetch', fetchMock);
        await refreshAccessToken('private-old', { exchangeId: 'exchange-1', siteId: 'site-1', accountId: 'hashed-account' });
        expect(logEvent).toHaveBeenCalledWith('warn', 'tesla.refresh.exchange-failed', expect.objectContaining({
            stage: 'request', cancellationSource: 'endpoint', failureCode: 'REQUEST_TIMEOUT', outcomeUnknown: true,
            exchangeId: 'exchange-1', siteId: 'site-1', accountId: 'hashed-account',
        }));
        const requests = logEvent.mock.calls.filter(([, event]) => event === 'tesla.refresh.request-started');
        expect(requests.map(([, , fields]) => fields.host)).toEqual([
            'https://fleet-auth.prd.vn.cloud.tesla.com', 'https://auth.tesla.com',
        ]);
        expect(JSON.stringify(logEvent.mock.calls)).not.toContain('private-');
    });

    it('identifies an endpoint timeout after headers even when body reading throws a generic error', async () => {
        const timeout = new AbortController();
        vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true, status: 200, json: async () => {
                timeout.abort(new DOMException('private-timeout', 'TimeoutError'));
                throw new TypeError('private-body-error');
            },
        }));
        await expect(refreshAccessToken('private-old')).rejects.toBeInstanceOf(TypeError);
        expect(logEvent).toHaveBeenCalledWith('warn', 'tesla.refresh.exchange-failed', expect.objectContaining({
            stage: 'response-body', cancellationSource: 'endpoint', failureCode: 'REQUEST_TIMEOUT', outcomeUnknown: true,
        }));
        expect(JSON.stringify(logEvent.mock.calls)).not.toContain('private-');
    });

});
