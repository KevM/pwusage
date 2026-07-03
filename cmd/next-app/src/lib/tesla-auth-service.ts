import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';
import { TeslaTokenRepo } from './tesla-token-repo';
import { SiteRepo } from './site-repo';
import { UserRepo } from './user-repo';
import { TeslaClient, TeslaClientConfig } from './tesla-client';
import { Importer } from './importer';

// Whitelist of allowed Tesla OAuth issuers.
// Typed as a non-empty tuple so it satisfies jsonwebtoken's VerifyOptions.issuer
// (string | [string, ...string[]]) while still supporting .includes().
const ALLOWED_TESLA_ISSUERS: [string, ...string[]] = [
    'https://auth.tesla.com/oauth2/v3/nts',
    'https://auth.tesla.com/oauth2/v3',
];

// Map issuer to its OIDC discovery endpoint
export function getDiscoveryEndpointFromIssuer(issuer: string): string | null {
    if (!issuer.includes('tesla.com')) {
        console.warn('[TeslaAuthService] Issuer not from Tesla domain:', issuer);
        return null;
    }
    if (issuer.startsWith('https://auth.tesla.com/oauth2/v3')) {
        return 'https://auth.tesla.com/oauth2/v3/.well-known/openid-configuration';
    }
    const parts = issuer.split('/');
    if (parts[parts.length - 1] === 'nts') {
        parts.pop();
    }
    return `${parts.join('/')}/.well-known/openid-configuration`;
}

// Discover the correct JWKS endpoint from OpenID Connect discovery
async function getTeslaJwksUri(issuer?: string): Promise<string> {
    let discoveryUrl = 'https://auth.tesla.com/oauth2/v3/.well-known/openid-configuration';

    if (issuer) {
        const discoveryFromIssuer = getDiscoveryEndpointFromIssuer(issuer);
        if (discoveryFromIssuer) {
            discoveryUrl = discoveryFromIssuer;
            console.log('[TeslaAuthService] Using discovery endpoint derived from issuer:', discoveryUrl);
        }
    }

    try {
        console.log('[TeslaAuthService] Discovering JWKS endpoint from OIDC configuration');
        const response = await fetch(discoveryUrl, {
            method: 'GET',
            headers: { 'Accept': 'application/json' }
        });
        console.log('[TeslaAuthService] OIDC discovery response status:', response.status);

        if (response.ok) {
            const config = await response.json();
            console.log('[TeslaAuthService] OIDC discovery successful, config issuer:', config.issuer);
            if (config.jwks_uri) {
                console.log('[TeslaAuthService] Using discovered JWKS URI:', config.jwks_uri);
                return config.jwks_uri;
            }
        } else {
            console.error('[TeslaAuthService] OIDC discovery failed with status', response.status);
        }
    } catch (e) {
        console.error('[TeslaAuthService] OIDC discovery failed:', e);
    }

    console.log('[TeslaAuthService] Using fallback JWKS endpoint: https://auth.tesla.com/oauth2/v3/discovery/keys');
    return 'https://auth.tesla.com/oauth2/v3/discovery/keys';
}

let teslaJwksClient: ReturnType<typeof jwksClient> | null = null;
let teslaJwksUri: string | null = null;
let lastIssuer: string | null = null;

async function getOrCreateJwksClient(issuer?: string) {
    if (!teslaJwksClient || (issuer && issuer !== lastIssuer)) {
        if (issuer !== lastIssuer) {
            console.log('[TeslaAuthService] Issuer changed, creating new JWKS client');
            lastIssuer = issuer || null;
        }
        teslaJwksUri = await getTeslaJwksUri(issuer);
        teslaJwksClient = jwksClient({
            jwksUri: teslaJwksUri,
            cache: true,
            cacheMaxAge: 10 * 60 * 1000,
            rateLimit: true,
        });
    }
    return teslaJwksClient;
}

async function fetchFreshJwks(jwksUri: string): Promise<{ keys?: Array<{ kid?: string; kty?: string }> }> {
    const response = await fetch(jwksUri, {
        headers: { 'Cache-Control': 'no-cache' }
    });
    if (!response.ok) {
        throw new Error(`Failed to fetch JWKS: ${response.status}`);
    }
    return response.json() as Promise<{ keys?: Array<{ kid?: string; kty?: string }> }>;
}

async function logAvailableKeys(jwksUri: string, label: string = '') {
    try {
        const jwks = await fetchFreshJwks(jwksUri);
        const keyIds = (jwks.keys || []).map(k => k.kid).filter(Boolean);
        console.log(`[TeslaAuthService] ${label} Available key IDs in JWKS:`, keyIds);
    } catch (e) {
        console.error('[TeslaAuthService] Failed to log available keys:', e);
    }
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

function getTeslaSigningKeyWithIssuer(header: jwt.JwtHeader, issuer: string | undefined, callback: jwt.SigningKeyCallback) {
    getOrCreateJwksClient(issuer).then(client => {
        console.log('[TeslaAuthService] Looking for signing key with kid:', header.kid);
        client.getSigningKey(header.kid, async (err, key) => {
            if (!err && key) {
                const signingKey = key.getPublicKey();
                callback(null, signingKey);
                return;
            }

            console.warn('[TeslaAuthService] Key not in cached JWKS, attempting lazy refresh', {
                kid: header.kid,
                error: err?.message
            });

            if (!teslaJwksUri) {
                callback(err || new Error('JWKS URI not available'));
                return;
            }

            try {
                const freshJwks = await fetchFreshJwks(teslaJwksUri);
                console.log('[TeslaAuthService] Fresh JWKS fetched, looking for kid again:', header.kid);

                const foundKey = (freshJwks.keys || []).find(k => k.kid === header.kid);
                if (foundKey) {
                    console.log('[TeslaAuthService] Found key in fresh JWKS after lazy refresh');
                    client.getSigningKey(header.kid, (retryErr, retryKey) => {
                        if (retryErr) {
                            console.error('[TeslaAuthService] Error retrieving key after lazy refresh:', {
                                kid: header.kid,
                                error: retryErr.message
                            });
                            if (teslaJwksUri) {
                                void logAvailableKeys(teslaJwksUri, 'AFTER REFRESH');
                            }
                            callback(retryErr);
                        } else if (retryKey) {
                            const signingKey = retryKey.getPublicKey();
                            callback(null, signingKey);
                        } else {
                            callback(new KidNotFoundError(header.kid));
                        }
                    });
                } else {
                    console.error('[TeslaAuthService] Key confirmed not present in JWKS after lazy refresh:', header.kid);
                    if (teslaJwksUri) {
                        void logAvailableKeys(teslaJwksUri, 'FINAL');
                    }
                    callback(new KidNotFoundError(header.kid));
                }
            } catch (refreshErr) {
                console.error('[TeslaAuthService] Failed to refresh JWKS (network error):', refreshErr);
                callback(refreshErr instanceof Error ? refreshErr : new Error(String(refreshErr)));
            }
        });
    }).catch(err => {
        console.error('[TeslaAuthService] Failed to get JWKS client:', err);
        callback(err instanceof Error ? err : new Error(String(err)));
    });
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
        console.log('[TeslaAuthService] Expected audience (client_id):', process.env.PUBLIC_TESLA_OAUTH_CLIENT_ID);

        const tokenIssuer = (decoded?.payload as Record<string, unknown>)?.iss as string | undefined;

        jwt.verify(
            token,
            (header, callback) => getTeslaSigningKeyWithIssuer(header, tokenIssuer, callback),
            {
                algorithms: ['RS256'],
                audience: process.env.PUBLIC_TESLA_OAUTH_CLIENT_ID,
                clockTolerance: 10,
                issuer: ALLOWED_TESLA_ISSUERS
            },
            (err, decoded) => {
                if (err) {
                    console.error('[TeslaAuthService] JWT verification error:', {
                        name: err.name,
                        message: err.message
                    });
                    return reject(err);
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

export type TeslaCallbackResult =
    | { status: 'state-mismatch' }
    | { status: 'token-exchange-failed'; statusCode: number }
    | { status: 'invalid-id-token' }
    | { status: 'nonce-mismatch' }
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
    tokenExchange?: (code: string, callbackUrl: string) => Promise<{ id_token: string; access_token: string; refresh_token: string; expires_in: number }>;
    verifyIdToken?: (token: string) => Promise<jwt.JwtPayload>;
}

export class TeslaAuthService {
    constructor(private deps: TeslaAuthServiceDeps = {}) {}

    async handleTeslaCallback(params: TeslaCallbackParams): Promise<TeslaCallbackResult> {
        const { code, state, savedState, savedNonce, callbackUrl } = params;

        if (state !== savedState) {
            return { status: 'state-mismatch' };
        }

        // Exchange Token
        let authData: { id_token: string; access_token: string; refresh_token: string; expires_in: number };
        if (this.deps.tokenExchange) {
            authData = await this.deps.tokenExchange(code, callbackUrl);
        } else {
            const tokenResponse = await fetch("https://auth.tesla.com/oauth2/v3/token", {
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                body: new URLSearchParams({
                    client_id: process.env.PUBLIC_TESLA_OAUTH_CLIENT_ID!,
                    client_secret: process.env.TESLA_OAUTH_SECRET!,
                    audience: process.env.PUBLIC_TESLA_OAUTH_AUDIENCE!,
                    redirect_uri: callbackUrl,
                    grant_type: "authorization_code",
                    code: code,
                }),
            });

            if (!tokenResponse.ok) {
                return { status: 'token-exchange-failed', statusCode: tokenResponse.status };
            }

            authData = await tokenResponse.json();
        }

        // Verify ID Token
        let decoded: jwt.JwtPayload;
        let signatureVerified = false;
        try {
            if (this.deps.verifyIdToken) {
                decoded = await this.deps.verifyIdToken(authData.id_token);
                signatureVerified = true;
            } else {
                // Wrap default verify with a 3-second timeout
                let timeoutId: NodeJS.Timeout | undefined;
                try {
                    const verificationPromise = verifyTeslaIdToken(authData.id_token);
                    const timeoutPromise = new Promise<never>((_, reject) => {
                        timeoutId = setTimeout(() => reject(new Error('Verification timeout')), 3000);
                    });
                    decoded = await Promise.race([verificationPromise, timeoutPromise]);
                    signatureVerified = true;
                    console.log('[TeslaAuthService] ID Token signature verified successfully');
                } finally {
                    if (timeoutId) clearTimeout(timeoutId);
                }
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
            const expectedAud = process.env.PUBLIC_TESLA_OAUTH_CLIENT_ID;
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

        let userEmail: string | undefined;
        let userId: string | undefined;

        let userInfo: { email?: string; id?: string; sub?: string; vault_uuid?: string } | null = null;
        try {
            userInfo = await client.getUserInfo();
            if (userInfo) {
                userEmail = userInfo.email;
                if (userInfo.email) {
                    userId = userInfo.email;
                }
            }
        } catch (e) {
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
        } else {
            // Degraded path (unpublished kid): getUserInfo() is MANDATORY!
            if (!userInfo || !userEmail) {
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

        try {
            console.log('[TeslaAuthService] Fetching products to ensure sites exist in DB...');
            const products = await client.getProducts();

            await userRepo.upsertOnTeslaAuth({
                userId,
                email: userEmail ?? null,
                accessToken: authData.access_token,
                refreshToken: authData.refresh_token,
                tokenExpiresAt: Date.now() + (authData.expires_in * 1000),
            });

            const userRow = await userRepo.getById(userId);
            roles = (userRow as { roles?: string[] } | null)?.roles ?? [];

            if (products.length > 0 || roles.includes('admin')) {
                const importer = this.deps.importerCreator
                    ? this.deps.importerCreator(client)
                    : new Importer(client);

                for (const product of products) {
                    if (!product.energy_site_id) {
                        continue;
                    }
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
            }
        } catch (dbError) {
            console.error('[TeslaAuthService] Failed to update/import sites in DB:', dbError);
        }

        return {
            status: 'success',
            userId,
            siteIds,
            roles
        };
    }
}
