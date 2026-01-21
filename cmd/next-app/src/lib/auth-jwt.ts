import jwt from 'jsonwebtoken';

const AUTH_SECRET = process.env.AUTH_SECRET || 'default-dev-secret-do-not-use-in-prod';

// Configurable via Env (defaults: 7 days expiry, refresh if < 24h remaining)
const EXPIRY_DAYS = parseInt(process.env.JWT_EXPIRY_DAYS || '7', 10);
const REFRESH_HOURS = parseInt(process.env.JWT_REFRESH_THRESHOLD_HOURS || '24', 10);


export const COOKIE_MAX_AGE_SECONDS = EXPIRY_DAYS * 24 * 60 * 60;
const REFRESH_THRESHOLD_SECONDS = REFRESH_HOURS * 60 * 60;

export interface SiteAuthClaims {
    sites: string[];
    roles?: string[]; // Added roles
    iat?: number;
    exp?: number;
}

export function signSiteToken(siteIds: string[], roles: string[] = []): string {
    return jwt.sign({ sites: siteIds, roles }, AUTH_SECRET, {
        expiresIn: COOKIE_MAX_AGE_SECONDS
    });
}

export function verifySiteToken(token: string): { sites: string[], roles: string[] } | null {
    try {
        const decoded = jwt.verify(token, AUTH_SECRET) as SiteAuthClaims;
        if (decoded && Array.isArray(decoded.sites)) {
            return { sites: decoded.sites, roles: decoded.roles || [] };
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
export function checkRefreshNeeded(token: string): string | null {
    try {
        const decoded = jwt.verify(token, AUTH_SECRET) as SiteAuthClaims;
        if (!decoded || !decoded.exp || !Array.isArray(decoded.sites)) return null;

        const now = Math.floor(Date.now() / 1000);
        const timeRemaining = decoded.exp - now;

        if (timeRemaining < REFRESH_THRESHOLD_SECONDS) {
            // Token is valid but expiring soon -> Refresh
            return signSiteToken(decoded.sites, decoded.roles || []);
        }

        return null;
    } catch {
        // Invalid token, do nothing (middleware will likely redirect/fail later if needed)
        return null;
    }
}
