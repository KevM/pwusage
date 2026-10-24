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

// signSiteToken always issues HS256. Pinning it here means a future change to
// AUTH_SECRET (for example an asymmetric key) cannot silently make verification
// accept a token signed with an unexpected algorithm.
const SITE_TOKEN_ALGORITHM = 'HS256';

export interface SiteAuthClaims {
    sites: string[];
    roles?: string[]; // Added roles
    sub?: string;     // User ID (Standard JWT Subject claim)
    sv?: number;      // session_version from User row; absent = legacy token (treated as 0)
    orig_iat?: number; // Original issued at (for absolute session cap)
    iat?: number;
    exp?: number;
}

export function signSiteToken(siteIds: string[], roles: string[] = [], userId?: string, originalIat?: number, sessionVersion: number = 0): string {
    const now = Math.floor(Date.now() / 1000);
    const payload: SiteAuthClaims = {
        sites: siteIds,
        roles,
        sv: sessionVersion,
        orig_iat: originalIat || now
    };
    if (userId) payload.sub = userId;

    return jwt.sign(payload, getAuthSecret(), {
        expiresIn: COOKIE_MAX_AGE_SECONDS
    });
}

export function verifySiteToken(token: string): { sites: string[], roles: string[], sub?: string, sv?: number, orig_iat?: number } | null {
    try {
        const decoded = jwt.verify(token, getAuthSecret(), { algorithms: [SITE_TOKEN_ALGORITHM] }) as SiteAuthClaims;
        if (decoded && Array.isArray(decoded.sites)) {
            return {
                sites: decoded.sites,
                roles: decoded.roles || [],
                sub: decoded.sub,
                sv: decoded.sv,
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
        const decoded = jwt.verify(token, getAuthSecret(), { algorithms: [SITE_TOKEN_ALGORITHM] }) as SiteAuthClaims;
        if (!decoded || !decoded.exp || !Array.isArray(decoded.sites)) return null;

        const now = Math.floor(Date.now() / 1000);
        const timeRemaining = decoded.exp - now;

        // Check absolute session lifetime
        if (decoded.orig_iat && (now - decoded.orig_iat) > MAX_SESSION_SECONDS) {
            console.log(`[AuthJWT] Session expired (absolute lifetime ${MAX_SESSION_DAYS} days reached)`);
            return null;
        }

        if (timeRemaining < REFRESH_THRESHOLD_SECONDS) {
            let refreshedSites = decoded.sites;
            let refreshedRoles = decoded.roles || [];
            let refreshedSessionVersion = decoded.sv ?? 0;

            // Don't extend a session for a revoked/deactivated user and re-derive fresh
            // roles/sites from DB. Authorization paths (e.g. SiteService.validateSiteAccess)
            // trust JWT claims directly, so re-deriving roles and sites on refresh ensures
            // role demotions and site unassignments take effect on the next refresh window
            // rather than persisting until the 30-day absolute session cap.
            // (Safe here: Next 16 proxy runs on the Node.js runtime, so the
            // user-repo / site-repo / pg import works.)
            if (decoded.sub) {
                const { UserRepo } = await import('./user-repo');
                const { SiteRepo } = await import('./site-repo');

                const userRepo = new UserRepo();
                const user = await userRepo.getById(decoded.sub);

                // Match UserRepo.isActive() semantics (is_active === true): the
                // column is a nullable BOOLEAN, so treat NULL/undefined as
                // inactive too. Refusing here must be at least as strict as the
                // JWT-only authz paths, never more permissive.
                if (!user || user.is_active !== true) {
                    console.warn(`[AuthJWT] Refusing to refresh token for revoked/inactive user ${decoded.sub}`);
                    return null;
                }

                // Refuse to refresh a session revoked by sign-out-everywhere (or any
                // session_version bump). Legacy tokens without `sv` are treated as 0,
                // so they refresh (and migrate to the current sv) only while the DB
                // version is still 0. Once the version is bumped, old tokens are
                // blocked here permanently — re-stamping the new sv here would
                // auto-un-revoke a stolen/revoked session on its next refresh window.
                const dbSessionVersion = user.session_version ?? 0;
                const tokenSessionVersion = decoded.sv ?? 0;
                if (tokenSessionVersion < dbSessionVersion) {
                    console.warn(`[AuthJWT] Refusing to refresh revoked session for user ${decoded.sub} (token sv=${tokenSessionVersion} < db sv=${dbSessionVersion})`);
                    return null;
                }

                refreshedRoles = user.roles || [];
                refreshedSessionVersion = dbSessionVersion;

                const siteRepo = new SiteRepo();
                const userSites = await siteRepo.getSitesForUser(decoded.sub);
                refreshedSites = userSites.map(s => s.id);
            }

            // Token is valid but expiring soon -> Refresh with updated claims
            return signSiteToken(refreshedSites, refreshedRoles, decoded.sub, decoded.orig_iat, refreshedSessionVersion);
        }

        return null;
    } catch (err) {
        // Verification failed (expired/tampered/malformed). Surface it: a silent
        // catch here previously hid a broken refresh path for weeks. Logging the
        // error name lets us distinguish "cookie present but rejected" (e.g.
        // TokenExpiredError) from "cookie absent" when diagnosing reauth issues.
        console.warn(`[AuthJWT] checkRefreshNeeded could not verify token: ${(err as Error)?.name ?? 'unknown error'}`);
        return null;
    }
}
