import { TeslaRefreshError } from './tesla-refresh-outcome';
import { logEvent } from './observability';
import { ioSignal, checkIoDeadline, abortable, ioFailureDetails } from './io-deadline';
// Tesla's Fleet API documentation states that calls to /token must use the
// fleet-auth host, because server-to-server calls carry different rate limits.
// The OIDC discovery document still declares auth.tesla.com, so Tesla's own
// docs disagree; we try the documented host first and fall back.
//
// Deliberately module-private: exporting it would invite an environment override
// capable of redirecting client_secret to an arbitrary origin.
const TOKEN_ENDPOINT_HOSTS: readonly string[] = [
    'https://fleet-auth.prd.vn.cloud.tesla.com',
    'https://auth.tesla.com',
];

// Without a per-attempt timeout, a TCP blackhole on the primary host hangs until
// the platform kills the function and the fallback never runs — which is the
// exact failure mode (a regional edge outage) the fallback exists for.
const TOKEN_REQUEST_TIMEOUT_MS = 8000;

export interface RefreshExchangeContext {
    exchangeId: string;
    siteId?: string;
    accountId?: string;
}

export class TeslaTokenEndpointError extends Error {
    constructor(message: string, public readonly status: number | null) {
        super(message);
        this.name = 'TeslaTokenEndpointError';
    }
}

// ReadableStream.cancel() rejects when the stream is already errored, which
// undici can produce mid-read while an upstream is flapping. Without a catch
// that becomes an unhandled rejection — a 500 where a clean 502 was intended.
function discardBody(response: Response): void {
    void response.body?.cancel().catch(() => undefined);
}

/**
 * POST form-encoded parameters to Tesla's /token endpoint, preferring the
 * documented fleet-auth host.
 *
 * Authorization-code exchange falls back on transport failures and 5xx.
 * Refresh exchange never replays after dispatch: loss of the response may hide
 * consumption of the grant. HTTP 4xx responses are classified by the caller.
 * Redirects are never followed, so credentials stay on the selected origin.
 */
export async function postToTeslaTokenEndpoint(
    params: Record<string, string>,
    fetchImpl: typeof fetch = fetch,
    context?: RefreshExchangeContext
): Promise<{ response: Response; host: string; signal: AbortSignal }> {
    const body = new URLSearchParams(params);
    let lastFailure: string | null = null;
    let lastStatus: number | null = null;

    for (const host of TOKEN_ENDPOINT_HOSTS) {
        const url = `${host}/oauth2/v3/token`;

        const startedAt = Date.now();
        const inherited = ioSignal();
        const timeout = AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS);
        const signal = inherited ? AbortSignal.any([inherited, timeout]) : timeout;
        const fields = { ...context, host };
        let requestInitiated = false;
        let response: Response;
        try {
            checkIoDeadline();
            if (context) logEvent('info', 'tesla.refresh.request-started', fields);
            requestInitiated = true;
            response = await abortable(fetchImpl(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body,
                // Do NOT let undici follow a redirect: a 307/308 preserves the
                // method and body, so following one would re-POST client_secret
                // to whatever origin the redirect names. Verified against a real
                // server on 2026-09-30: with the default, a 307 delivered the full
                // form body to the redirect target; with 'manual' the 3xx is
                // surfaced here, hits the unexpected-status branch below, and the
                // target receives nothing.
                redirect: 'manual',
                signal,
            }), signal);
        } catch (err) {
            if (context) logEvent('warn', 'tesla.refresh.exchange-failed', {
                ...fields, stage: 'request', durationMs: Date.now() - startedAt,
                ...ioFailureDetails(err, signal), outcomeUnknown: requestInitiated,
            });
            if (params.grant_type === 'refresh_token') {
                throw new TeslaRefreshError(requestInitiated ? 'outcome_unknown' : 'not_dispatched');
            }
            checkIoDeadline();
            // A transport failure is not an HTTP status. Clear any 5xx seen on
            // an earlier host so `status` and the message cannot disagree, and
            // so Task 6 does not report 503 for what was a network failure.
            lastStatus = null;
            // Keep transport/proxy details out of errors and logs: they can contain secrets.
            lastFailure = 'transport error';
            console.warn(
                `[TeslaTokenEndpoint] Transport failure calling ${host}; trying next host`
            );
            continue;
        }

        if (context) logEvent('info', 'tesla.refresh.response-received', {
            ...fields, status: response.status, durationMs: Date.now() - startedAt,
        });
        if (response.ok) {
            return { response, host, signal };
        }

        // A 4xx is a genuine authentication failure. Retrying it against a
        // second origin would mask the real error and re-send client_secret.
        if (response.status >= 400 && response.status < 500) {
            return { response, host, signal };
        }

        if (params.grant_type === 'refresh_token') {
            discardBody(response);
            throw new TeslaRefreshError('outcome_unknown', response.status);
        }

        // Everything else that is neither 2xx nor 4xx: an unexpected 1xx/2xx/3xx,
        // such as a redirect we deliberately did not follow. These throw instead
        // of falling through to the next host, because *that* is the case where
        // the body could name a third-party origin — the 3xx branch above is the
        // only path that could hand client_secret somewhere outside Tesla.
        //
        // Note that a 5xx does fall through, and does re-POST the secret to
        // auth.tesla.com. That is the documented failover below, not an oversight
        // in this comment: both hosts are Tesla's own, so the retry stays inside
        // one publisher's trust boundary. Do not "harden" this by refusing to
        // re-send on 5xx — the primary host having a bad day is precisely the
        // regional-edge outage the second host exists for, and losing login
        // availability to avoid a secret crossing Tesla's own two hosts would be
        // a worse failure than the one this guards.
        if (response.status < 500) {
            discardBody(response);
            // Logged because this is the one failure mode whose cause is invisible
            // from the outside: a Tesla-side redirect surfaces to the user as an
            // unexplained login failure, and the thrown message alone only reaches
            // the logs if the framework happens to report an unhandled route error.
            console.warn(
                `[TeslaTokenEndpoint] ${host} returned unexpected ${response.status}; `
                + 'not falling through to the next host'
            );
            throw new TeslaTokenEndpointError(
                `Unexpected ${response.status} from ${host}`,
                response.status
            );
        }

        lastStatus = response.status;
        lastFailure = `HTTP ${response.status}`;
        console.warn(`[TeslaTokenEndpoint] ${host} returned ${response.status}; trying next host`);
        discardBody(response);
    }

    throw new TeslaTokenEndpointError(
        `All Tesla token endpoints failed. Last failure: ${lastFailure ?? 'unknown'}`,
        lastStatus
    );
}
