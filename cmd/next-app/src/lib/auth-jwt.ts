import jwt from 'jsonwebtoken';

const AUTH_SECRET = process.env.AUTH_SECRET || 'default-dev-secret-do-not-use-in-prod';
const IS_PROD = process.env.NODE_ENV === 'production';

function getAuthSecret(): string {
    if (IS_PROD && (!process.env.AUTH_SECRET || process.env.AUTH_SECRET === 'default-dev-secret-do-not-use-in-prod')) {
        throw new Error('AUTH_SECRET environment variable is required in production');
    }
    return AUTH_SECRET;
}

// Configurable via Env (defaults: 7 days expiry, refresh if < 24h remaining)
const EXPIRY_DAYS = parseInt(process.env.JWT_EXPIRY_DAYS || '7', 10);
const REFRESH_HOURS = parseInt(process.env.JWT_REFRESH_THRESHOLD_HOURS || '24', 10);
const MAX_SESSION_DAYS = 30; // Absolute limit even with sliding refresh

export const COOKIE_MAX_AGE_SECONDS = EXPIRY_DAYS * 24 * 60 * 60;
const REFRESH_THRESHOLD_SECONDS = REFRESH_HOURS * 60 * 60;
const MAX_SESSION_SECONDS = MAX_SESSION_DAYS * 24 * 60 * 60;

export interface SiteAuthClaims {
    sites: string[];
    roles?: string[]; // Added roles
    sub?: string;     // User ID (Standard JWT Subject claim)
    orig_iat?: number; // Original issued at (for absolute session cap)
    iat?: number;
    exp?: number;
}

export function signSiteToken(siteIds: string[], roles: string[] = [], userId?: string, originalIat?: number): string {
    const now = Math.floor(Date.now() / 1000);
    const payload: SiteAuthClaims = {
        sites: siteIds,
        roles,
        orig_iat: originalIat || now
    };
    if (userId) payload.sub = userId;

    return jwt.sign(payload, getAuthSecret(), {
        expiresIn: COOKIE_MAX_AGE_SECONDS
    });
}

export function verifySiteToken(token: string): { sites: string[], roles: string[], sub?: string, orig_iat?: number } | null {
    try {
        const decoded = jwt.verify(token, getAuthSecret()) as SiteAuthClaims;
        if (decoded && Array.isArray(decoded.sites)) {
            return {
                sites: decoded.sites,
                roles: decoded.roles || [],
                sub: decoded.sub,
                orig_iat: decoded.orig_iat
            };
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * Checks if the token needs refreshing (is nearing expiration).
 * Returns the new token if refreshed, or null if not needed/invalid.
 */
export async function checkRefreshNeeded(token: string): Promise<string | null> {
    try {
        const decoded = jwt.verify(token, getAuthSecret()) as SiteAuthClaims;
        if (!decoded || !decoded.exp || !Array.isArray(decoded.sites)) return null;

        const now = Math.floor(Date.now() / 1000);
        const timeRemaining = decoded.exp - now;

        // Check absolute session lifetime
        if (decoded.orig_iat && (now - decoded.orig_iat) > MAX_SESSION_SECONDS) {
            console.log(`[AuthJWT] Session expired (absolute lifetime ${MAX_SESSION_DAYS} days reached)`);
            return null;
        }

        if (timeRemaining < REFRESH_THRESHOLD_SECONDS) {
            // Check if user is still active in DB before refreshing
            if (decoded.sub) {
                const { isUserActive } = await import('./user-repo');
                if (!(await isUserActive(decoded.sub))) {
                    console.warn(`[AuthJWT] Refusal to refresh token for revoked/inactive user ${decoded.sub}`);
                    return null;
                }
            }

            // Token is valid but expiring soon -> Refresh
            return signSiteToken(decoded.sites, decoded.roles || [], decoded.sub, decoded.orig_iat);
        }

        return null;
    } catch {
        // Invalid token, do nothing
        return null;
    }
}
