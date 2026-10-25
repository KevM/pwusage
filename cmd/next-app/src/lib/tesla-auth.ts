import { abortable } from './io-deadline';
import { TeslaAuthError } from './tesla-client';
import { requireEnv } from './env';
import { postToTeslaTokenEndpoint } from './tesla-token-endpoint';

// Tesla requires form encoding for server-to-server token calls. The previous
// implementation sent JSON and defaulted client_id to the literal 'ownerapi',
// which would have presented our client_secret to the first-party Owner API if
// the environment variable were ever missing.
//
// The refresh grant takes client_id and refresh_token; `audience` is only
// required on the authorization-code exchange, so it is deliberately absent
// here and has no environment variable.
const REFRESH_SCOPE = 'openid email offline_access';

function parseTokenErrorCode(body: string): string | null {
    try {
        const parsed: unknown = JSON.parse(body);
        if (typeof parsed !== 'object' || parsed === null) return null;
        const { error } = parsed as Record<string, unknown>;
        return typeof error === 'string' ? error : null;
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

export async function refreshAccessToken(refreshToken: string): Promise<RefreshedTokens> {
    const { response } = await postToTeslaTokenEndpoint({
        grant_type: 'refresh_token',
        client_id: requireEnv('PUBLIC_TESLA_OAUTH_CLIENT_ID'),
        client_secret: requireEnv('TESLA_OAUTH_SECRET'),
        refresh_token: refreshToken,
        scope: REFRESH_SCOPE,
    });

    if (!response.ok) {
        const body = await abortable(response.text());
        const errorCode = parseTokenErrorCode(body);
        const terminalCode = response.status === 400
            && (errorCode === 'invalid_grant' || errorCode === 'login_required');
        const terminal = response.status === 401 || terminalCode;
        // Never interpolate the body: isTeslaAuthError matches message
        // substrings, so arbitrary upstream text could otherwise revoke a user.
        // Only a recognized terminal code is safe to echo.
        const detail = terminalCode ? ` ${errorCode}` : '';
        const message = `Failed to refresh token: ${response.status}${detail}`;
        if (terminal) {
            throw new TeslaAuthError(message, response.status);
        }
        throw new Error(message);
    }

    return parseRefreshedTokens(await abortable(response.json()));
}
