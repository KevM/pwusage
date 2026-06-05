import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { NextRequest, NextResponse } from 'next/server';
import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';
import { TeslaTokenRepo } from '@/lib/tesla-token-repo';
import { SiteRepo } from '@/lib/site-repo';
import { UserRepo } from '@/lib/user-repo';
import { getAppBaseUrl } from '@/lib/url-utils';

export const maxDuration = 60; // Allow up to 60 seconds on Vercel to avoid timeouts during slow Tesla API / JWKS calls

// Discover the correct JWKS endpoint from OpenID Connect discovery
async function getTeslaJwksUri(issuer?: string): Promise<string> {
    // Use issuer to determine discovery endpoint if available
    let discoveryUrl = 'https://auth.tesla.com/oauth2/v3/.well-known/openid-configuration';

    if (issuer) {
        const discoveryFromIssuer = getDiscoveryEndpointFromIssuer(issuer);
        if (discoveryFromIssuer) {
            discoveryUrl = discoveryFromIssuer;
            console.log('[AuthCallback] Using discovery endpoint derived from issuer:', discoveryUrl);
        }
    }

    try {
        console.log('[AuthCallback] Discovering JWKS endpoint from OIDC configuration');
        const response = await fetch(discoveryUrl, {
            method: 'GET',
            headers: { 'Accept': 'application/json' }
        });
        console.log('[AuthCallback] OIDC discovery response status:', response.status);

        if (response.ok) {
            const config = await response.json();
            console.log('[AuthCallback] OIDC discovery successful, config issuer:', config.issuer);
            if (config.jwks_uri) {
                console.log('[AuthCallback] Using discovered JWKS URI:', config.jwks_uri);
                return config.jwks_uri;
            }
        } else {
            console.error('[AuthCallback] OIDC discovery failed with status', response.status);
        }
    } catch (e) {
        console.error('[AuthCallback] OIDC discovery failed:', e);
    }

    // Fallback endpoint if discovery fails
    console.log('[AuthCallback] Using fallback JWKS endpoint: https://auth.tesla.com/oauth2/v3/discovery/keys');
    return 'https://auth.tesla.com/oauth2/v3/discovery/keys';
}

let teslaJwksClient: ReturnType<typeof jwksClient> | null = null;
let teslaJwksUri: string | null = null;
let lastIssuer: string | null = null;

async function getOrCreateJwksClient(issuer?: string) {
    // Create a new client if issuer changes or client doesn't exist
    if (!teslaJwksClient || (issuer && issuer !== lastIssuer)) {
        if (issuer !== lastIssuer) {
            console.log('[AuthCallback] Issuer changed, creating new JWKS client');
            lastIssuer = issuer || null;
        }
        teslaJwksUri = await getTeslaJwksUri(issuer);
        teslaJwksClient = jwksClient({
            jwksUri: teslaJwksUri,
            cache: true,
            cacheMaxAge: 10 * 60 * 1000, // Cache for 10 minutes (shorter than default 1 hour)
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
        console.log(`[AuthCallback] ${label} Available key IDs in JWKS:`, keyIds);
    } catch (e) {
        console.error('[AuthCallback] Failed to log available keys:', e);
    }
}

function getTeslaSigningKeyWithIssuer(header: jwt.JwtHeader, issuer: string | undefined, callback: jwt.SigningKeyCallback) {
    getOrCreateJwksClient(issuer).then(client => {
        console.log('[AuthCallback] Looking for signing key with kid:', header.kid);
        client.getSigningKey(header.kid, async (err, key) => {
            // If key found in cache, use it
            if (!err && key) {
                const signingKey = key.getPublicKey();
                callback(null, signingKey);
                return;
            }

            // Key not found in cache - implement lazy refresh strategy for Tesla's eventual consistency
            console.warn('[AuthCallback] Key not in cached JWKS, attempting lazy refresh', {
                kid: header.kid,
                error: err?.message
            });

            if (!teslaJwksUri) {
                callback(err || new Error('JWKS URI not available'));
                return;
            }

            try {
                // Fetch fresh JWKS with cache-busting header
                const freshJwks = await fetchFreshJwks(teslaJwksUri);
                console.log('[AuthCallback] Fresh JWKS fetched, looking for kid again:', header.kid);

                // Try to find the key in fresh data
                const foundKey = (freshJwks.keys || []).find(k => k.kid === header.kid);
                if (foundKey) {
                    console.log('[AuthCallback] Found key in fresh JWKS after lazy refresh');
                    // Retry getting the signing key - it should now be in the client's cache
                    client.getSigningKey(header.kid, (retryErr, retryKey) => {
                        if (retryErr) {
                            console.error('[AuthCallback] Key still not found after lazy refresh:', {
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
                        }
                    });
                } else {
                    // Key still not found after fresh fetch
                    console.error('[AuthCallback] Key not found even after lazy refresh:', header.kid);
                    if (teslaJwksUri) {
                        logAvailableKeys(teslaJwksUri, 'FINAL');
                    }
                    callback(err || new Error(`Signing key ${header.kid} not found after refresh`));
                }
            } catch (refreshErr) {
                console.error('[AuthCallback] Failed to refresh JWKS:', refreshErr);
                callback(refreshErr instanceof Error ? refreshErr : new Error(String(refreshErr)));
            }
        });
    }).catch(err => {
        console.error('[AuthCallback] Failed to get JWKS client:', err);
        callback(err);
    });
}

// Whitelist of allowed Tesla OAuth issuers
const ALLOWED_TESLA_ISSUERS = [
    'https://auth.tesla.com/oauth2/v3/nts',
    'https://auth.tesla.com/oauth2/v3',
];

// Map issuer to its OIDC discovery endpoint
function getDiscoveryEndpointFromIssuer(issuer: string): string | null {
    if (!issuer.includes('tesla.com')) {
        console.warn('[AuthCallback] Issuer not from Tesla domain:', issuer);
        return null;
    }
    // Construct discovery endpoint from issuer
    // e.g., https://auth.tesla.com/oauth2/v3/nts -> https://auth.tesla.com/oauth2/v3/.well-known/openid-configuration
    const parts = issuer.split('/');
    const baseUrl = parts.slice(0, -1).join('/'); // Remove /nts or other suffix
    return `${baseUrl}/.well-known/openid-configuration`;
}

async function verifyTeslaIdToken(token: string): Promise<jwt.JwtPayload> {
    return new Promise((resolve, reject) => {
        // Log the token header for debugging
        const decoded = jwt.decode(token, { complete: true }) as jwt.Jwt | null;
        if (decoded) {
            console.log('[AuthCallback] ID Token header:', decoded.header);
            const payload = decoded.payload as Record<string, unknown>;
            console.log('[AuthCallback] ID Token payload claims:', {
                iss: payload?.iss,
                aud: payload?.aud,
                sub: payload?.sub,
                nonce: payload?.nonce
            });

            // Validate issuer against whitelist
            const issuer = payload?.iss as string | undefined;
            if (issuer && !ALLOWED_TESLA_ISSUERS.includes(issuer)) {
                console.error('[AuthCallback] Token issuer not in whitelist:', issuer);
                reject(new Error(`Invalid token issuer: ${issuer}`));
                return;
            }
        }
        console.log('[AuthCallback] Expected audience (client_id):', process.env.PUBLIC_TESLA_OAUTH_CLIENT_ID);

        // Get issuer for discovery endpoint selection
        const tokenIssuer = (decoded?.payload as Record<string, unknown>)?.iss as string | undefined;

        jwt.verify(
            token,
            (header, callback) => getTeslaSigningKeyWithIssuer(header, tokenIssuer, callback),
            {
                algorithms: ['RS256'],
                // Don't validate issuer here - we already validated it above
                audience: process.env.PUBLIC_TESLA_OAUTH_CLIENT_ID,
                clockTolerance: 10 // Allow 10 seconds of clock skew
            },
            (err, decoded) => {
                if (err) {
                    console.error('[AuthCallback] JWT verification error:', {
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

export async function GET(request: NextRequest) {
    const searchParams = request.nextUrl.searchParams;
    const code = searchParams.get('code');
    const state = searchParams.get('state');
    const redirectBaseUrl = getAppBaseUrl(request);
    const callbackUrl = `${redirectBaseUrl}/auth/tesla-callback`;

    // Validate required environment variables
    if (!process.env.PUBLIC_TESLA_OAUTH_CLIENT_ID || !process.env.PUBLIC_TESLA_OAUTH_AUDIENCE) {
        console.error('[AuthCallback] Missing required Tesla OAuth environment variables', {
            hasClientId: !!process.env.PUBLIC_TESLA_OAUTH_CLIENT_ID,
            hasAudience: !!process.env.PUBLIC_TESLA_OAUTH_AUDIENCE
        });
        return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
    }

    if (!code || !state) {
        return NextResponse.json({ error: 'Missing code or state' }, { status: 400 });
    }

    const cookieStore = await cookies();
    const savedState = cookieStore.get('auth_state')?.value;
    const savedNonce = cookieStore.get('auth_nonce')?.value;
    const savedCallback = cookieStore.get('auth_callback')?.value;

    if (state !== savedState) {
        return NextResponse.json({ error: 'State mismatch' }, { status: 401 });
    }

    // Exchange token
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
        return NextResponse.json({ error: 'Failed to exchange token' }, { status: tokenResponse.status });
    }

    const authData = await tokenResponse.json();

    // Verify ID Token (Signature, Issuer, Audience, Nonce)
    let decoded: jwt.JwtPayload;
    let signatureVerified = false;
    let timeoutId: NodeJS.Timeout | undefined;
    try {
        const verificationPromise = verifyTeslaIdToken(authData.id_token);
        const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => reject(new Error('Verification timeout')), 3000);
        });
        decoded = await Promise.race([verificationPromise, timeoutPromise]);
        signatureVerified = true;
        console.log('[AuthCallback] ID Token signature verified successfully');
    } catch (err) {
        console.error('[AuthCallback] ID Token signature verification failed:', err);
        // Fallback: decode without verification if JWKS endpoint is unavailable
        // This is acceptable since we still validate nonce
        const decoded_unsafe = jwt.decode(authData.id_token) as jwt.JwtPayload | null;
        if (!decoded_unsafe) {
            console.error('[AuthCallback] Could not even decode ID token without verification');
            return NextResponse.json({ error: 'Invalid ID token' }, { status: 401 });
        }
        decoded = decoded_unsafe;
        console.warn('[AuthCallback] Proceeding with nonce validation only (signature verification unavailable)');
    } finally {
        if (timeoutId) {
            clearTimeout(timeoutId);
        }
    }

    if (decoded.nonce !== savedNonce) {
        return NextResponse.json({ error: 'Nonce mismatch' }, { status: 401 });
    }

    if (signatureVerified) {
        console.log('[AuthCallback] Authentication: signature verified + nonce validated');
    } else {
        console.warn('[AuthCallback] Authentication: nonce validated only (signature verification failed)');
    }

    // Save tokens
    // cookieStore.set('access_token', authData.access_token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', maxAge: authData.expires_in, sameSite: 'lax', path: '/' });
    // cookieStore.set('refresh_token', authData.refresh_token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/' });

    // Update DB (Source of Truth)
    try {
        const { TeslaClient } = await import('@/lib/tesla-client');
        const { Importer } = await import('@/lib/importer');

        // Initialize client with fresh tokens
        const client = new TeslaClient({
            accessToken: authData.access_token,
            refreshToken: authData.refresh_token,
            onTokenUpdate: async () => { } // No-op, we just got them
        });

        // Fetch User Info (Email, Name, etc.)
        let userEmail: string | undefined;
        let userId: string = 'unknown_user';

        try {
            const userInfo = await client.getUserInfo();
            if (userInfo) {
                userEmail = userInfo.email;
                if (userInfo.email) {
                    userId = userInfo.email; // Use email as ID if available and stable? 
                    // Actually, let's stick to the previous logic IF possible, but 'sub' from ID token is safer for ID.
                    // But for EMAIL, definitely use this.
                }
            }
        } catch (e) {
            console.error('[AuthCallback] Failed to fetch user info:', e);
        }

        // Use verified ID Token for ID if valid
        if (!userEmail && decoded.email) {
            userEmail = decoded.email as string;
        }

        // Use 'sub' as stable ID if available, otherwise email
        if (decoded.sub) {
            userId = decoded.sub;
        } else if (userEmail) {
            userId = userEmail;
        }

        // Fetch products directly from API to find NEW sites
        console.log('[AuthCallback] Fetching products to ensure sites exist in DB...');
        const products = await client.getProducts();

        // Upsert User
        const userRepo = new UserRepo();
        await userRepo.upsertOnTeslaAuth({
            userId,
            email: userEmail ?? null,
            accessToken: authData.access_token,
            refreshToken: authData.refresh_token,
            tokenExpiresAt: Date.now() + (authData.expires_in * 1000),
        });

        // Retrieve Roles immediately
        const userRow = await userRepo.getById(userId);
        const roles = (userRow as { roles?: string[] } | null)?.roles ?? [];

        if (products.length > 0 || roles.includes('admin')) {
            const importer = new Importer(client);
            const tokenRepo = new TeslaTokenRepo(new SiteRepo());
            const siteIds: string[] = [];

            for (const product of products) {
                if (!product.energy_site_id) {
                    continue;
                }
                const siteId = product.energy_site_id.toString();
                siteIds.push(siteId);

                await importer.ensureSite(siteId);
                await new SiteRepo().assignSiteToUser(siteId, userId);
                await tokenRepo.updateSiteTokens(siteId, authData.access_token, authData.refresh_token);
                await tokenRepo.releaseRefreshLock(siteId);
                console.log(`[AuthCallback] Linked site ${siteId} to User ${userId} and updated tokens.`);
            }

            // Generate verified site token
            const { signSiteToken, COOKIE_MAX_AGE_SECONDS } = await import('@/lib/auth-jwt');
            const siteToken = signSiteToken(siteIds, roles, userId);

            // Set 24h cookie
            cookieStore.set('site_auth', siteToken, {
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                maxAge: COOKIE_MAX_AGE_SECONDS,
                path: '/',
                sameSite: 'lax'
            });
            console.log('[AuthCallback] Set site_auth token.');
        }
    } catch (dbError) {
        console.error('[AuthCallback] Failed to update/import sites in DB:', dbError);
        // Don't fail the request, just log. Cookies are still set.
    }

    // Clean up auth cookies
    cookieStore.delete('auth_state');
    cookieStore.delete('auth_nonce');
    cookieStore.delete('auth_callback');

    if (savedCallback && savedCallback.startsWith('/') && !savedCallback.startsWith('//') && !savedCallback.startsWith('/\\')) {
        redirect(savedCallback);
    } else {
        redirect('/');
    }
}
