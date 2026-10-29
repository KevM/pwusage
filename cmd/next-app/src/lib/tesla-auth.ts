import { randomUUID } from 'node:crypto';
import { logEvent } from './observability';
import { abortable, ioFailureDetails } from './io-deadline';
import { TeslaRefreshError, type TeslaOAuthErrorCode } from './tesla-refresh-outcome';
import { requireEnv } from './env';
import { postToTeslaTokenEndpoint, type RefreshExchangeContext } from './tesla-token-endpoint';

// Tesla requires form encoding for server-to-server token calls. The previous
// implementation sent JSON and defaulted client_id to the literal 'ownerapi',
// which would have presented our client_secret to the first-party Owner API if
// the environment variable were ever missing.
//
// The refresh grant takes client_id and refresh_token; `audience` is only
// required on the authorization-code exchange, so it is deliberately absent
// here and has no environment variable.
const REFRESH_SCOPE = 'openid email offline_access';

function parseTokenErrorCode(body: string): TeslaOAuthErrorCode | null {
    try {
        const parsed: unknown = JSON.parse(body);
        if (typeof parsed !== 'object' || parsed === null) return null;
        const { error } = parsed as Record<string, unknown>;
        return error === 'invalid_grant' || error === 'login_required' || error === 'invalid_client'
            || error === 'unauthorized_client' || error === 'unsupported_grant_type' || error === 'invalid_request' ? error : null;
    } catch {
        return null;
    }
}

interface RefreshedTokens {
    access_token: string;
    refresh_token: string;
}

export type { RefreshedTokens };

/**
 * Narrow the token endpoint's JSON body to the two fields the caller needs.
 *
 * `Response.json()` is typed `any`, so returning it directly would leak that
 * `any` through a declared return type and let a malformed 200 reach
 * `updateSiteTokens` as `undefined`. This takes `unknown` instead, which erases
 * the `any` at the boundary. Empty strings are rejected for the same reason: an
 * empty token passes a `typeof` check but is just as unusable, and would be
 * written to the DB as the user's credentials.
 *
 * Throws a plain Error, not a TeslaAuthError: `isTeslaAuthError` also matches
 * several message substrings, and a body Tesla did not document is not evidence
 * that the refresh token was revoked — treating it as terminal would make
 * TeslaTokenRepo disable the user's account. The message below is a fixed
 * template: interpolating the payload would risk reproducing a trigger substring
 * (see DesignDecisions.md section 5).
 *
 * Exported because the authorization-code exchange validates against the same
 * rule and the same two fields — the refresh path and the exchange path are
 * twins, and one unvalidated twin is one bug away from the other.
 */
export function parseRefreshedTokens(payload: unknown): RefreshedTokens {
    if (typeof payload !== 'object' || payload === null) {
        throw new Error('Tesla token response was not a JSON object');
    }

    const { access_token, refresh_token } = payload as Record<string, unknown>;
    if (
        typeof access_token !== 'string' ||
        typeof refresh_token !== 'string' ||
        access_token === '' ||
        refresh_token === ''
    ) {
        throw new Error('Tesla token response did not include non-empty string access_token and refresh_token');
    }

    return { access_token, refresh_token };
}

export async function refreshAccessToken(refreshToken: string, context: RefreshExchangeContext = { exchangeId: randomUUID() }): Promise<RefreshedTokens> {
    let clientId: string;
    let clientSecret: string;
    try {
        clientId = requireEnv('PUBLIC_TESLA_OAUTH_CLIENT_ID');
        clientSecret = requireEnv('TESLA_OAUTH_SECRET');
    } catch (error) {
        throw new TeslaRefreshError('not_dispatched', null, null, error instanceof Error ? error.message : 'Missing Tesla configuration');
    }
    const { response, host, signal } = await postToTeslaTokenEndpoint({
        grant_type: 'refresh_token',
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        scope: REFRESH_SCOPE,
    }, fetch, context);

    const startedAt = Date.now();
    try {
        if (!response.ok) {
            const body = await abortable(response.text(), signal);
            const errorCode = parseTokenErrorCode(body);
            const terminal = (response.status === 400 || response.status === 401)
                && (errorCode === 'invalid_grant' || errorCode === 'login_required');
            const configuration = (response.status === 400 || response.status === 401)
                && (errorCode === 'invalid_client' || errorCode === 'unauthorized_client'
                    || errorCode === 'unsupported_grant_type' || errorCode === 'invalid_request');
            const outcome = terminal ? 'credential_rejected' : configuration ? 'configuration_rejected' : 'outcome_unknown';
            logEvent('warn', 'tesla.token-endpoint.rejected', {
                ...context, host, status: response.status, outcome, errorCode,
            });
            throw new TeslaRefreshError(outcome, response.status, errorCode);

        }

        const payload: unknown = await abortable(response.json(), signal);
        const next = parseRefreshedTokens(payload);
        const expiresIn = (payload as Record<string, unknown>).expires_in;
        const expiryMs = typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn >= 0
            ? Date.now() + expiresIn * 1000 : NaN;
        const expiry = Number.isFinite(expiryMs) && expiryMs <= 8640000000000000
            ? { accessExpiresInSeconds: expiresIn, accessExpiresAt: new Date(expiryMs).toISOString() } : {};
        logEvent('info', 'tesla.refresh.credentials-parsed', { ...context, host, durationMs: Date.now() - startedAt, ...expiry });
        return next;
    } catch (error) {
        logEvent('warn', 'tesla.refresh.exchange-failed', {
            ...context, host, stage: 'response-body', status: response.status,
            durationMs: Date.now() - startedAt, ...ioFailureDetails(error, signal),
            outcomeUnknown: response.ok,
        });
        if (error instanceof TeslaRefreshError) throw error;
        throw new TeslaRefreshError('outcome_unknown', response.status, null,
            'Tesla response could not be read or did not include valid access_token and refresh_token');
    }
}
