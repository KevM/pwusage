import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';
import { TeslaTokenRepo } from './tesla-token-repo';
import { SiteRepo } from './site-repo';
import { UserRepo } from './user-repo';
import {
    TeslaClient,
    TeslaClientConfig,
    TeslaRegionError,
    type FleetProduct,
} from './tesla-client';
import { Importer } from './importer';
import { isUniqueViolation } from './db';
import { requireEnv } from './env';
import {
    TeslaTokenEndpointError,
    postToTeslaTokenEndpoint,
} from './tesla-token-endpoint';
import { parseRefreshedTokens } from './tesla-auth';
import { DEFAULT_FLEET_BASE_URL } from './tesla-region';


// Whitelist of allowed Tesla OAuth issuers.
// Typed as a non-empty tuple so it satisfies jsonwebtoken's VerifyOptions.issuer
// (string | [string, ...string[]]) while still supporting .includes().
export const ALLOWED_TESLA_ISSUERS: [string, ...string[]] = [
    'https://auth.tesla.com/oauth2/v3/nts',
    'https://auth.tesla.com/oauth2/v3',
];

// Map issuer to its OIDC discovery endpoint. Each issuer publishes its own
// discovery document: the /nts issuer's jwks_uri (discovery/thirdparty/keys)
// holds different signing keys than the base /v3 JWKS, so the /nts suffix
// must be preserved or nts ID tokens fail kid lookup.
export function getDiscoveryEndpointFromIssuer(issuer: string): string | null {
    if (!issuer.includes('tesla.com')) {
        console.warn('[TeslaAuthService] Issuer not from Tesla domain:', issuer);
        return null;
    }
    return `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
}

// Each Tesla issuer publishes its own key set (verified 2026-09-30):
//   /nts -> /oauth2/v3/discovery/thirdparty/keys   <- what Tesla actually issues
//   /v3  -> /oauth2/v3/discovery/keys
// A single hardcoded fallback previously resolved the base /v3 set for /nts
// tokens, so any transient discovery failure produced a guaranteed kid miss
// and silently downgraded ID token signature verification.
//
// A Map rather than an object literal: object indexing would return inherited
// members (e.g. 'constructor') for an unrecognised issuer. Unreachable today
// because verifyTeslaIdToken rejects any issuer outside ALLOWED_TESLA_ISSUERS
// before key lookup, but this path is security-critical and cheap to harden.
const NTS_ISSUER = 'https://auth.tesla.com/oauth2/v3/nts';

const FALLBACK_JWKS_URIS = new Map<string, string>([
    [NTS_ISSUER, 'https://auth.tesla.com/oauth2/v3/discovery/thirdparty/keys'],
    ['https://auth.tesla.com/oauth2/v3', 'https://auth.tesla.com/oauth2/v3/discovery/keys'],
]);

export function getFallbackJwksUri(issuer?: string): string {
    const defaultUri = FALLBACK_JWKS_URIS.get(NTS_ISSUER);
    if (!defaultUri) {
        throw new Error(`Missing JWKS fallback for ${NTS_ISSUER}`);
    }
    return (issuer ? FALLBACK_JWKS_URIS.get(issuer) : undefined) ?? defaultUri;
}

const DISCOVERY_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const DISCOVERY_TIMEOUT_MS = 5000;

const discoveryCache = new Map<string, { uri: string; fetchedAt: number }>();

/**
 * The OAuth client id as issued, normalized the same way `requireEnv` normalizes it
 * before the exchange sends it. Every audience comparison must use this: a raw
 * `process.env` read disagrees with Tesla's token the moment the configured value has
 * surrounding whitespace, which fails every login as `invalid-id-token`.
 *
 * Returns undefined when unset, because `undefined` is what tells `jsonwebtoken` to skip
 * the audience check - `requireEnv` would make an optional check mandatory.
 */
function expectedTokenAudience(): string | undefined {
    const value = process.env.PUBLIC_TESLA_OAUTH_CLIENT_ID?.trim();
    return value ? value : undefined;
}

// Discover the correct JWKS endpoint from OpenID Connect discovery, cached per
// issuer so steady-state logins avoid a network round-trip before the JWKS
// fetch. Cold-path timeouts live here and on the jwks client, not wrapped
// around the whole verification: a warm cache hit performs no network I/O and
// therefore cannot hang.
//
// Unbounded by design-but-bounded-in-practice: the only caller is
// getOrCreateJwksClient, whose issuer is gated by ALLOWED_TESLA_ISSUERS, so the
// key space is at most three entries. A Map rather than an object literal so an
// unrecognised issuer can never resolve to an inherited member (see the note on
// FALLBACK_JWKS_URIS above).
export async function getTeslaJwksUri(issuer?: string): Promise<string> {
    const cacheKey = issuer ?? 'default';
    const cached = discoveryCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < DISCOVERY_CACHE_TTL_MS) {
        return cached.uri;
    }

    let discoveryUrl = 'https://auth.tesla.com/oauth2/v3/.well-known/openid-configuration';
    const discoveryFromIssuer = issuer ? getDiscoveryEndpointFromIssuer(issuer) : null;
    if (discoveryFromIssuer) {
        discoveryUrl = discoveryFromIssuer;
    }

    try {
        const response = await fetch(discoveryUrl, {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
            signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
        });

        if (response.ok) {
            const config = await response.json();
            if (typeof config?.jwks_uri === 'string') {
                discoveryCache.set(cacheKey, { uri: config.jwks_uri, fetchedAt: Date.now() });
                return config.jwks_uri;
            }
        } else {
            // warn, not error: every path below this point recovers — either by
            // reusing the cached URI or by using the issuer-aware fallback. A
            // discovery outage is expected to be survivable, so it must not page
            // whoever watches for error-level logs.
            console.warn('[TeslaAuthService] OIDC discovery failed with status', response.status);
        }
    } catch (e) {
        console.warn('[TeslaAuthService] OIDC discovery failed:', e);
    }

    // Note that the DISCOVERY_TIMEOUT_MS above lands here too: a *slow* discovery
    // is indistinguishable from a failed one once the signal aborts, so slow and
    // dead both fall through to the fallback below rather than propagating. That
    // is routine, not exceptional — this sits on the login critical path, and
    // there is no third option that keeps discovery on it. Both whitelisted
    // issuers appear in FALLBACK_JWKS_URIS, so the hardcoded URI names the right
    // key set either way and the login proceeds to the JWKS fetch.
    //
    // Discovery failed. Prefer a previously cached URI over any fallback, so a
    // transient failure does not downgrade us to a possibly different key set.
    if (cached) {
        console.warn('[TeslaAuthService] Discovery failed; reusing cached JWKS URI', cached.uri);
        return cached.uri;
    }

    const fallback = getFallbackJwksUri(issuer);
    console.warn('[TeslaAuthService] Discovery unavailable; using issuer-aware fallback:', fallback);
    return fallback;
}

let teslaJwksClient: ReturnType<typeof jwksClient> | null = null;
let lastIssuer: string | null = null;

const JWKS_CACHE_MAX_AGE_MS = 10 * 60 * 1000;
// Availability vs security trade, documented upstream: when the JWKS endpoint
// is unreachable and cacheMaxAge has expired, keep serving the last known good
// key for this additional window instead of failing every login. The cost is
// that a rotated-and-compromised key stays trusted for up to
// JWKS_CACHE_MAX_AGE_MS + this, i.e. 70 minutes from the last *successful*
// fetch. That total is a deliberate bound on our tolerance for stale keys, not
// a prediction of Tesla's recovery time: the window does not grow if Tesla's
// JWKS stays down longer, it just stops helping.
// onStaleCacheFallback makes every degraded serve observable so a long outage
// cannot pass silently.
//
// The library measures the stale window as
// `Date.now() - fetchedAt < cacheMaxAge + cacheMaxAgeFallback`
// (node_modules/jwks-rsa/src/wrappers/cache.js), so cacheMaxAge is *not* merely
// a freshness target — it is added to the exposure. See DesignDecisions.md §5.
const JWKS_STALE_FALLBACK_MS = 60 * 60 * 1000;
// jwks-rsa defaults `timeout` to 30000ms. Cut 6x because this value sits on the
// login critical path: it is now the primary bound on a slow JWKS endpoint,
// replacing the 3s race that 2ca62ef ("prevent Vercel function timeout on slow
// JWKS calls") put around the whole verification. That race also leaked — its
// `finally` cleared the timer but not the in-flight request. Be precise about
// what improved: for this path the user-visible outcome did NOT change. A slow
// JWKS fetch still fails the login with `invalid-id-token`, exactly as the race
// did. Only the cause reported in the logs got better — a real JWKS error
// instead of a generic `Verification timeout`. The discovery path is the one
// that started succeeding (see getTeslaJwksUri's fallback).
const JWKS_REQUEST_TIMEOUT_MS = 5000;
// Equals jwks-rsa's own default (wrappers/rateLimit.js), so this constant changes
// no behavior today. Pinned explicitly anyway: this app's JWKS traffic is a
// handful of logins per hour, so the limiter is never the binding constraint and
// the value is insurance against a retry loop, not a tuned throughput figure.
// Stating it here means a future library default change cannot silently alter
// the ceiling.
const JWKS_REQUESTS_PER_MINUTE = 10;

async function getOrCreateJwksClient(issuer?: string) {
    if (!teslaJwksClient || (issuer && issuer !== lastIssuer)) {
        lastIssuer = issuer || null;
        const jwksUri = await getTeslaJwksUri(issuer);
        teslaJwksClient = jwksClient({
            jwksUri,
            cache: true,
            cacheMaxEntries: 10,
            cacheMaxAge: JWKS_CACHE_MAX_AGE_MS,
            cacheMaxAgeFallback: JWKS_STALE_FALLBACK_MS,
            // jwks-rsa invokes this as onStaleCacheFallback(err, kid, key) and
            // only when the underlying failure carries isEndpointUnavailable, so
            // the log fires exclusively on the degraded-serve path.
            onStaleCacheFallback: (err: Error, kid: string | null | undefined) => {
                console.warn('[TeslaAuthService] Serving stale JWKS key; Tesla JWKS endpoint is unavailable', {
                    kid,
                    endpointError: err.message,
                });
            },
            rateLimit: true,
            jwksRequestsPerMinute: JWKS_REQUESTS_PER_MINUTE,
            timeout: JWKS_REQUEST_TIMEOUT_MS,
        });
    }
    return teslaJwksClient;
}

/**
 * Reset the module-level JWKS client and OIDC discovery caches.
 *
 * Exported for deterministic tests only; production code has no legitimate use.
 */
export function __resetJwksClientForTests(): void {
    teslaJwksClient = null;
    lastIssuer = null;
    discoveryCache.clear();
}

export class KidNotFoundError extends Error {
    constructor(public readonly kid?: string) {
        super(`Signing key ${kid ?? ''} not found in JWKS`);
        this.name = 'KidNotFoundError';
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, KidNotFoundError);
        }
    }
}

function getTeslaSigningKeyWithIssuer(
    header: jwt.JwtHeader,
    issuer: string | undefined,
    callback: jwt.SigningKeyCallback
) {
    getOrCreateJwksClient(issuer)
        .then(
            (client) =>
                new Promise<string>((resolve, reject) => {
                    client.getSigningKey(
                        header.kid,
                        (err: Error | null, key?: { getPublicKey(): string }) => {
                            if (err) {
                                // jwks-rsa v4 throws SigningKeyNotFoundError from
                                // exactly two sites in JwksClient.getSigningKey
                                // (node_modules/jwks-rsa/src/JwksClient.js):
                                //
                                //   1. "Unable to find a signing key that matches
                                //      '<kid>'" - the kid is absent from the key
                                //      set. The cache wrapper memoizes per kid and
                                //      keeps no second-level key set, so reaching
                                //      here means it already re-fetched the full
                                //      JWKS: this is the genuinely-absent case.
                                //   2. "No KID specified and JWKS endpoint
                                //      returned more than 1 key" - the token header
                                //      carried no kid, so no key could be selected.
                                //      This does NOT mean the set lacks the kid.
                                //
                                // Both funnel into KidNotFoundError, and
                                // handleTeslaCallback treats that as "signature
                                // unverifiable" and takes a degraded path that
                                // bypasses signature verification. That is
                                // acceptable only while case 2 is unreachable: the
                                // id_token is minted by Tesla in a real
                                // authorization-code exchange over TLS, so an
                                // attacker cannot strip its kid. If that stops
                                // being true, this condition must be narrowed to
                                // the message in case 1 and case 2 must fail
                                // closed.
                                //
                                // Every other error (endpoint unreachable, rate
                                // limited) must NOT become KidNotFoundError, or an
                                // outage would quietly open the bypass. jwks-rsa
                                // never disguises a transport failure as
                                // SigningKeyNotFoundError, so this split is sound.
                                if (err.name === 'SigningKeyNotFoundError') {
                                    reject(new KidNotFoundError(header.kid));
                                    return;
                                }
                                console.error('[TeslaAuthService] JWKS lookup failed without a confirmed missing key', {
                                    kid: header.kid,
                                    errorName: err.name,
                                    message: err.message,
                                });
                                reject(err);
                                return;
                            }
                            if (!key) {
                                reject(new KidNotFoundError(header.kid));
                                return;
                            }
                            resolve(key.getPublicKey());
                        }
                    );
                })
        )
        .then((signingKey) => callback(null, signingKey))
        .catch((err: unknown) => callback(err instanceof Error ? err : new Error(String(err))));
}

export async function verifyTeslaIdToken(token: string): Promise<jwt.JwtPayload> {
    return new Promise((resolve, reject) => {
        const decoded = jwt.decode(token, { complete: true }) as jwt.Jwt | null;
        if (decoded) {
            console.log('[TeslaAuthService] ID Token header:', decoded.header);
            const payload = decoded.payload as Record<string, unknown>;
            console.log('[TeslaAuthService] ID Token payload claims:', {
                iss: payload?.iss,
                aud: payload?.aud,
                sub: payload?.sub,
                nonce: payload?.nonce
            });

            const issuer = payload?.iss as string | undefined;
            if (issuer && !ALLOWED_TESLA_ISSUERS.includes(issuer)) {
                console.error('[TeslaAuthService] Token issuer not in whitelist:', issuer);
                reject(new Error(`Invalid token issuer: ${issuer}`));
                return;
            }
        }
        console.log('[TeslaAuthService] Expected audience (client_id):', expectedTokenAudience());

        const tokenIssuer = (decoded?.payload as Record<string, unknown>)?.iss as string | undefined;

        // jsonwebtoken re-wraps key-callback errors in a plain JsonWebTokenError,
        // keeping only the message. Capture the original error so a
        // KidNotFoundError survives to handleTeslaCallback's degraded path.
        let keyLookupError: Error | undefined;

        jwt.verify(
            token,
            (header, callback) => getTeslaSigningKeyWithIssuer(header, tokenIssuer, (err, key) => {
                if (err) {
                    keyLookupError = err;
                }
                callback(err, key);
            }),
            {
                algorithms: ['RS256'],
                audience: expectedTokenAudience(),
                clockTolerance: 10,
                issuer: ALLOWED_TESLA_ISSUERS
            },
            (err, decoded) => {
                if (err) {
                    const rejection = keyLookupError instanceof KidNotFoundError ? keyLookupError : err;
                    console.error('[TeslaAuthService] JWT verification error:', {
                        name: rejection.name,
                        message: rejection.message
                    });
                    return reject(rejection);
                }
                resolve(decoded as jwt.JwtPayload);
            }
        );
    });
}

export interface TeslaCallbackParams {
    code: string;
    state: string;
    savedState: string;
    savedNonce: string;
    callbackUrl: string;
}

// The documented /token response. Declared once so the injected `tokenExchange`
// seam and the parsed body cannot drift apart.
export interface ExchangedTokens {
    id_token: string;
    access_token: string;
    refresh_token: string;
    expires_in: number;
}

/**
 * Narrow the /token response the exchange path consumes.
 *
 * The twin of parseRefreshedTokens, which already covers `access_token` and
 * `refresh_token` and is called first so the two paths cannot drift. This adds
 * the two exchange-only fields: `id_token`, without which there is nothing to
 * verify, and `expires_in`, whose absence is the failure that reached the DB as
 * `NaN`. `pg` serialises NaN as the *string* "NaN" (pg/lib/utils.js:69), which
 * Postgres rejects for `"User"."token_expires_at" BIGINT` — so a missing
 * `expires_in` produced a silent-but-total login failure: the catch around the
 * DB writes swallowed the rejection and the callback still returned success.
 *
 * Non-finite numbers are rejected as well as non-numbers, because a NaN from a
 * `Number()`-style coercion is just as unusable as a string and `typeof` alone
 * would let it through.
 *
 * The messages are fixed templates, never an interpolation of the payload:
 * see the same rule in parseRefreshedTokens and DesignDecisions.md section 5.
 */
function parseExchangedTokens(payload: unknown): ExchangedTokens {
    const { access_token, refresh_token } = parseRefreshedTokens(payload);

    const { id_token, expires_in } = payload as Record<string, unknown>;
    if (typeof id_token !== 'string' || id_token === '') {
        throw new Error('Tesla token response did not include a non-empty string id_token');
    }
    if (typeof expires_in !== 'number' || !Number.isFinite(expires_in)) {
        throw new Error('Tesla token response did not include a finite numeric expires_in');
    }

    return { id_token, access_token, refresh_token, expires_in };
}

export type TeslaCallbackResult =
    | { status: 'state-mismatch' }
    | { status: 'token-exchange-failed'; statusCode: number }
    | { status: 'invalid-id-token' }
    | { status: 'nonce-mismatch' }
    | { status: 'db-error' }
    | {
        status: 'fleet-api-failed';
        reason: 'region' | 'upstream' | 'sites';
      }
    | {
        status: 'success';
        userId: string;
        siteIds: string[];
        roles: string[];
      };

export interface TeslaAuthServiceDeps {
    userRepo?: UserRepo;
    siteRepo?: SiteRepo;
    teslaTokenRepo?: TeslaTokenRepo;
    teslaClientCreator?: (config: TeslaClientConfig) => TeslaClient;
    importerCreator?: (client: TeslaClient) => Pick<Importer, 'ensureSite'>;
    tokenExchange?: (code: string, callbackUrl: string) => Promise<ExchangedTokens>;
    verifyIdToken?: (token: string) => Promise<jwt.JwtPayload>;
}

// Both token-exchange failure paths run through here, so the invariant holds in
// one direction only *for the pair*: anything that is not an HTTP error we
// actually received (a null status from a network failure, or an unexpected
// 3xx/1xx) becomes a 502 rather than being echoed into NextResponse.json's
// `status` option. The helper's contract makes the returned-response path 4xx
// today, so this is not a live bug — it is the guard that keeps a future helper
// change from emitting `NextResponse.json(..., { status: 302 })`.
function toUpstreamStatus(status: number | null): number {
    return status !== null && status >= 400 ? status : 502;
}

export class TeslaAuthService {
    constructor(private deps: TeslaAuthServiceDeps = {}) {}

    async handleTeslaCallback(params: TeslaCallbackParams): Promise<TeslaCallbackResult> {
        const { code, state, savedState, savedNonce, callbackUrl } = params;

        if (state !== savedState) {
            return { status: 'state-mismatch' };
        }

        // Exchange Token
        let authData: ExchangedTokens;
        if (this.deps.tokenExchange) {
            authData = await this.deps.tokenExchange(code, callbackUrl);
        } else {
            let tokenResponse: Response;
            try {
                // Tesla documents fleet-auth as the required host for
                // server-to-server /token calls; see tesla-token-endpoint.ts
                // for the fallback policy.
                const exchange = await postToTeslaTokenEndpoint({
                    client_id: requireEnv('PUBLIC_TESLA_OAUTH_CLIENT_ID'),
                    client_secret: requireEnv('TESLA_OAUTH_SECRET'),
                    audience: DEFAULT_FLEET_BASE_URL,
                    redirect_uri: callbackUrl,
                    grant_type: 'authorization_code',
                    code,
                });
                tokenResponse = exchange.response;
            } catch (err) {
                // Every Tesla host failed. Without this catch the error escapes
                // handleTeslaCallback, and src/app/auth/tesla-callback/route.ts
                // rethrows it on the web path — converting today's clean 503
                // token-exchange-failed response into a raw 500.
                if (!(err instanceof TeslaTokenEndpointError)) throw err;
                console.error('[TeslaAuthService] Token exchange failed on all hosts:', err.message);
                return { status: 'token-exchange-failed', statusCode: toUpstreamStatus(err.status) };
            }

            if (!tokenResponse.ok) {
                return { status: 'token-exchange-failed', statusCode: toUpstreamStatus(tokenResponse.status) };
            }

            try {
                authData = parseExchangedTokens(await tokenResponse.json());
            } catch (err) {
                // A 2xx body we cannot use is an upstream fault, so report it as
                // an exchange failure at 502 rather than letting the error
                // escape: route.ts rethrows anything that leaves
                // handleTeslaCallback on the web path, and a malformed JSON body
                // or a missing `expires_in` must not become a raw 500. Failing
                // here is the point — the previous code assigned `response.json()`
                // (typed `any`) straight into the declared shape, so a 200
                // without `expires_in` reached tokenExpiresAt as NaN, was
                // rejected by Postgres as the string "NaN", had that rejection
                // swallowed by the catch around the DB writes below, and then
                // returned success with siteIds: [] — no cookie, no error.
                console.error('[TeslaAuthService] Token exchange returned a malformed 2xx response:', err);
                return { status: 'token-exchange-failed', statusCode: toUpstreamStatus(null) };
            }
        }

        // Verify ID Token
        let decoded: jwt.JwtPayload;
        let signatureVerified = false;
        try {
            if (this.deps.verifyIdToken) {
                decoded = await this.deps.verifyIdToken(authData.id_token);
                signatureVerified = true;
            } else {
                // No outer timeout race here: timeouts belong on the individual
                // requests. Note that a warm *discovery* cache skips only the
                // discovery fetch — a cold JWKS fetch can still take up to
                // JWKS_REQUEST_TIMEOUT_MS — so "cached" is not a guarantee that
                // this call cannot block. What the removal buys is accuracy, not
                // speed: a slow response now surfaces as the real discovery or
                // JWKS error instead of a generic timeout. In the logs that is
                // unambiguous; the login itself still fails with
                // `invalid-id-token` on a slow JWKS fetch, and still succeeds
                // on a slow or failed discovery, via getTeslaJwksUri's fallback.
                decoded = await verifyTeslaIdToken(authData.id_token);
                signatureVerified = true;
                console.log('[TeslaAuthService] ID Token signature verified successfully');
            }
        } catch (err) {
            const isKidNotFound = err instanceof KidNotFoundError || (err instanceof Error && err.name === 'KidNotFoundError');
            if (!isKidNotFound) {
                console.error('[TeslaAuthService] ID Token verification failed with critical error (not KidNotFoundError):', err);
                return { status: 'invalid-id-token' };
            }

            console.warn('[TeslaAuthService] ID Token signature check bypassed due to unpublished Tesla kid (KidNotFoundError). Falling back to claims verification & authenticated TLS getUserInfo API call.');
            
            const decodedUnsafe = jwt.decode(authData.id_token) as jwt.JwtPayload | null;
            if (!decodedUnsafe) {
                console.error('[TeslaAuthService] Could not decode ID token in fallback path');
                return { status: 'invalid-id-token' };
            }

            // Manually enforce claims in fallback path: iss, aud, exp
            const nowSeconds = Math.floor(Date.now() / 1000);

            // Check issuer
            const tokenIss = decodedUnsafe.iss as string | undefined;
            if (!tokenIss || !ALLOWED_TESLA_ISSUERS.includes(tokenIss)) {
                console.error('[TeslaAuthService] Fallback claims check failed: invalid issuer', tokenIss);
                return { status: 'invalid-id-token' };
            }

            // Check audience if configured
            const expectedAud = expectedTokenAudience();
            if (expectedAud) {
                const tokenAud = decodedUnsafe.aud;
                const audMatch = Array.isArray(tokenAud) ? tokenAud.includes(expectedAud) : tokenAud === expectedAud;
                if (!audMatch) {
                    console.error('[TeslaAuthService] Fallback claims check failed: audience mismatch', { tokenAud, expectedAud });
                    return { status: 'invalid-id-token' };
                }
            }

            // Check expiration (with 10s clock tolerance)
            const tokenExp = decodedUnsafe.exp as number | undefined;
            if (!tokenExp || (tokenExp + 10) < nowSeconds) {
                console.error('[TeslaAuthService] Fallback claims check failed: token expired', { tokenExp, nowSeconds });
                return { status: 'invalid-id-token' };
            }

            decoded = decodedUnsafe;
        }

        if (decoded.nonce !== savedNonce) {
            return { status: 'nonce-mismatch' };
        }

        if (signatureVerified) {
            console.log('[TeslaAuthService] Authentication: signature verified + nonce validated');
        } else {
            console.warn('[TeslaAuthService] Authentication: degraded path (unpublished kid); nonce & claims validated, enforcing getUserInfo TLS API check');
        }

        // Setup Repos / services
        const userRepo = this.deps.userRepo || new UserRepo();
        const siteRepo = this.deps.siteRepo || new SiteRepo();
        const teslaTokenRepo = this.deps.teslaTokenRepo || new TeslaTokenRepo(siteRepo);

        const teslaClientConfig = {
            accessToken: authData.access_token,
            refreshToken: authData.refresh_token,
            onTokenUpdate: async () => {}
        };

        const client = this.deps.teslaClientCreator
            ? this.deps.teslaClientCreator(teslaClientConfig)
            : new TeslaClient(teslaClientConfig);

        // Non-NA accounts get 421 "user out of region" from the default host, so
        // find the account's regional host before any other Fleet call. If this
        // fails, the client still follows a 421's base URL on the calls below.
        try {
            await client.resolveRegion();
        } catch (e) {
            console.warn('[TeslaAuthService] Failed to resolve Tesla region; relying on 421 redirects:', e);
        }

        let userEmail: string | undefined;
        let userId: string | undefined;

        let userInfo: { email?: string; id?: string; sub?: string; vault_uuid?: string } | null = null;
        let userInfoError: unknown;
        try {
            userInfo = await client.getUserInfo();
            if (userInfo) {
                userEmail = userInfo.email;
                if (userInfo.email) {
                    userId = userInfo.email;
                }
            }
        } catch (e) {
            userInfoError = e;
            console.error('[TeslaAuthService] Failed to fetch user info:', e);
        }

        if (signatureVerified) {
            if (!userEmail && decoded.email) {
                userEmail = decoded.email as string;
            }
            if (decoded.sub) {
                userId = decoded.sub;
            } else if (userEmail) {
                userId = userEmail;
            }
            // Reconcile to an existing account that owns this email (e.g. a
            // legacy row keyed by the email from the pre-fix degraded path).
            // The DB enforces one User row per email (idx_user_email_lower),
            // so adopting the existing id prevents both account splitting and
            // a unique violation on the upsert below.
            if (userEmail && userId) {
                const existingUser = await userRepo.getByEmail(userEmail);
                if (existingUser && existingUser.id !== userId) {
                    console.log('[TeslaAuthService] Reconciled verified sub to existing user account by email:', {
                        email: userEmail,
                        existingUserId: existingUser.id
                    });
                    userId = existingUser.id;
                }
            }
        } else {
            // Degraded path (unpublished kid): getUserInfo() is MANDATORY!
            if (!userInfo || !userEmail) {
                if (userInfoError instanceof TeslaRegionError) {
                    return { status: 'fleet-api-failed', reason: 'region' };
                }
                console.error('[TeslaAuthService] Fallback auth failed: getUserInfo() call failed or returned no user email');
                return { status: 'invalid-id-token' };
            }

            // Consistency check 1: If unverified id_token has an email claim, require case-insensitive match with userInfo.email
            if (decoded.email && decoded.email.toLowerCase() !== userEmail.toLowerCase()) {
                console.error('[TeslaAuthService] Fallback auth failed: decoded.email mismatch with userInfo.email', {
                    decodedEmail: decoded.email,
                    userInfoEmail: userEmail
                });
                return { status: 'invalid-id-token' };
            }

            // Consistency check 2: If userInfo exposes explicit sub/id (standard OIDC fields), require match with decoded.sub
            const userInfoExplicitSub = userInfo.sub ?? userInfo.id;
            if (decoded.sub && userInfoExplicitSub && decoded.sub !== userInfoExplicitSub) {
                console.error('[TeslaAuthService] Fallback auth failed: decoded.sub mismatch with userInfo.sub/id', {
                    decodedSub: decoded.sub,
                    userInfoExplicitSub
                });
                return { status: 'invalid-id-token' };
            }

            // Log-only check for vault_uuid to avoid false-positive lockouts if vault_uuid is in a different namespace
            if (decoded.sub && userInfo.vault_uuid && decoded.sub !== userInfo.vault_uuid) {
                console.warn('[TeslaAuthService] Note: decoded.sub does not match userInfo.vault_uuid (different ID namespaces)', {
                    decodedSub: decoded.sub,
                    vaultUuid: userInfo.vault_uuid
                });
            }

            // P2 FIX: Do NOT use an unverified decoded.sub without userInfo confirmation!
            // Only use decoded.sub if it was confirmed by userInfo (userInfoExplicitSub or vault_uuid).
            // Otherwise, reconcile via userRepo.getByEmail() to reuse the existing account ID and prevent account splitting.
            const isSubConfirmed = decoded.sub && (
                (userInfoExplicitSub && decoded.sub === userInfoExplicitSub) ||
                (userInfo.vault_uuid && decoded.sub === userInfo.vault_uuid)
            );

            if (isSubConfirmed && decoded.sub) {
                userId = decoded.sub;
            } else {
                const existingUser = await userRepo.getByEmail(userEmail);
                if (existingUser) {
                    console.log('[TeslaAuthService] Reconciled unconfirmed sub to existing user account by email:', {
                        email: userEmail,
                        existingUserId: existingUser.id
                    });
                    userId = existingUser.id;
                } else {
                    userId = userEmail;
                }
            }
        }

        if (!userId) {
            console.error('[TeslaAuthService] Could not establish user identity');
            return { status: 'invalid-id-token' };
        }

        const siteIds: string[] = [];
        let roles: string[] = [];

        const persistCredentials = (targetUserId: string) => userRepo.upsertOnTeslaAuth({
            userId: targetUserId,
            email: userEmail ?? null,
            accessToken: authData.access_token,
            refreshToken: authData.refresh_token,
            tokenExpiresAt: Date.now() + (authData.expires_in * 1000),
            fleetApiBaseUrl: client.getBaseUrl(),
        });

        // Persist before any product import: a Fleet failure must not discard a
        // rotated refresh token, and it must not be reported as a successful login.
        try {
            try {
                await persistCredentials(userId);
            } catch (err) {
                // idx_user_email_lower rejected the insert: a concurrent login
                // created a row with this email after our getByEmail lookup.
                // Adopt that row's id and retry once.
                if (!isUniqueViolation(err) || !userEmail) throw err;
                const existingUser = await userRepo.getByEmail(userEmail);
                if (!existingUser) throw err;
                console.warn('[TeslaAuthService] Upsert hit email unique violation; adopting existing account:', {
                    email: userEmail,
                    existingUserId: existingUser.id
                });
                userId = existingUser.id;
                await persistCredentials(userId);
            }
        } catch (dbError) {
            console.error('[TeslaAuthService] Failed to persist Tesla credentials:', dbError);
            return { status: 'db-error' };
        }

        let persistedBaseUrl = client.getBaseUrl();
        const storeLearnedBaseUrl = async () => {
            const learnedBaseUrl = client.getBaseUrl();
            if (learnedBaseUrl === persistedBaseUrl) return;
            try {
                await persistCredentials(userId);
                persistedBaseUrl = learnedBaseUrl;
            } catch (err) {
                // Tokens are already stored; a later call re-learns the host.
                console.error('[TeslaAuthService] Failed to store learned Fleet host:', err);
            }
        };

        try {
            const userRow = await userRepo.getById(userId);
            roles = (userRow as { roles?: string[] } | null)?.roles ?? [];
        } catch (dbError) {
            console.error('[TeslaAuthService] Failed to load user roles:', dbError);
            return { status: 'db-error' };
        }

        let products: FleetProduct[] = [];
        try {
            console.log('[TeslaAuthService] Fetching products to ensure sites exist in DB...');
            products = await client.getProducts();
        } catch (err) {
            const reason = err instanceof TeslaRegionError ? 'region' : 'upstream';
            console.error(`[TeslaAuthService] Failed to fetch Tesla products (${reason}):`, err);
            // An admin needs access even when Fleet is unavailable or this
            // region's partner registration is missing.
            if (!roles.includes('admin')) {
                await storeLearnedBaseUrl();
                return { status: 'fleet-api-failed', reason };
            }
        }

        await storeLearnedBaseUrl();

        const importableProducts = products.filter(
            (product): product is FleetProduct & { energy_site_id: number } => Boolean(product.energy_site_id)
        );

        if (importableProducts.length > 0) {
            const importer = this.deps.importerCreator
                ? this.deps.importerCreator(client)
                : new Importer(client);

            for (const product of importableProducts) {
                const siteId = product.energy_site_id.toString();

                try {
                    await importer.ensureSite(siteId);
                    await siteRepo.assignSiteToUser(siteId, userId);
                    await teslaTokenRepo.updateSiteTokens(siteId, authData.access_token, authData.refresh_token);
                    await teslaTokenRepo.releaseRefreshLock(siteId);
                    siteIds.push(siteId);
                    console.log(`[TeslaAuthService] Linked site ${siteId} to User ${userId} and updated tokens.`);
                } catch (err) {
                    console.error(`[TeslaAuthService] Failed to import/assign site ${siteId}:`, err);
                }
            }

            if (siteIds.length === 0 && !roles.includes('admin')) {
                await storeLearnedBaseUrl();
                return { status: 'fleet-api-failed', reason: 'sites' };
            }
        }

        await storeLearnedBaseUrl();

        return {
            status: 'success',
            userId,
            siteIds,
            roles
        };
    }
}
