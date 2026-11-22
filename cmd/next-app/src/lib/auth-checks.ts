import { cache } from 'react';
import { cookies } from 'next/headers';
import { validateSessionAgainstAuthState, verifySiteToken } from './auth-jwt';
import { UserRepo } from './user-repo';
import { SiteRepo, type SiteSummary } from './site-repo';
import { logSessionRejection } from './observability';

const SITE_AUTH_COOKIE = 'site_auth';

interface ResolvedAuth {
    userId?: string;
    roles: string[];
    siteIds: string[];
    /**
     * id + name rows from the same membership read that produced `siteIds`.
     * Absent for legacy tokens, whose claimed IDs may name deleted sites.
     */
    sites?: SiteSummary[];
}

/**
 * Resolves the request's auth state from the DB (source of truth) after
 * verifying the site_auth JWT. The JWT is only a cache: active status,
 * session_version, roles, and site memberships always come from the DB so
 * revoked sessions and stale claims take effect immediately, not at token
 * expiry. Legacy tokens without `sv` are treated as session_version 0.
 * Tokens without `sub` (pre-PR-#86) cannot be DB-checked and keep the
 * historical token-claims behavior.
 */
const resolveAuth = cache(async (): Promise<ResolvedAuth | null> => {
    const cookieStore = await cookies();
    const token = cookieStore.get(SITE_AUTH_COOKIE)?.value;
    if (!token) {
        logSessionRejection('missing-cookie');
        return null;
    }

    const decoded = verifySiteToken(token);
    if (!decoded) return null;

    if (!decoded.sub) {
        // Legacy token without a subject claim: no DB identity to check.
        return { roles: decoded.roles, siteIds: decoded.sites };
    }

    const authState = await new UserRepo().getAuthState(decoded.sub);
    const rejection = validateSessionAgainstAuthState(
        { sub: decoded.sub, sv: decoded.sv, orig_iat: decoded.orig_iat },
        authState
    );
    if (rejection) {
        logSessionRejection(rejection, decoded.sub);
        if (rejection === 'inactive-account' || rejection === 'missing-account') {
            console.warn(`[AuthChecks] Blocking access for revoked/inactive user: ${decoded.sub}`);
        } else if ((decoded.sv ?? 0) < (authState?.sessionVersion ?? 0)) {
            console.warn(`[AuthChecks] Blocking revoked session for user ${decoded.sub} (token sv=${decoded.sv ?? 0} < db sv=${authState?.sessionVersion})`);
        }
        return null;
    }
    if (!authState) return null;

    const sites = await new SiteRepo().getSiteSummariesForUser(decoded.sub);
    return {
        userId: decoded.sub,
        roles: authState.roles,
        siteIds: sites.map(s => s.id),
        sites
    };
});

/** The signed-in user's roles from the DB-checked auth state; [] when signed out. */
export const getCurrentRoles = cache(async (): Promise<string[]> => {
    const auth = await resolveAuth();
    return auth ? auth.roles : [];
});

export const isUserAdmin = cache(async (): Promise<boolean> => {
    const auth = await resolveAuth();
    return !!auth && auth.roles.includes('admin');
});

/**
 * True when the request carries a site_auth session that passes the DB checks
 * (active user, current session_version). Unlike getAuthorizedSiteIds(), this
 * distinguishes a revoked session from a valid car-only session with no sites.
 */
export const hasValidSession = cache(async (): Promise<boolean> => {
    return !!(await resolveAuth());
});

export const getCurrentUser = cache(async (): Promise<{ id: string, email?: string } | null> => {
    const auth = await resolveAuth();
    if (!auth || !auth.userId) return null;
    return { id: auth.userId };
});

export const verifySiteAccess = cache(async (siteId: string): Promise<boolean> => {
    const auth = await resolveAuth();
    if (!auth) return false;
    return auth.siteIds.includes(siteId) || auth.roles.includes('admin');
});

export const getAuthorizedSiteIds = cache(async (): Promise<string[]> => {
    const auth = await resolveAuth();
    return auth ? auth.siteIds : [];
});

/**
 * The signed-in user's sites as id + name, for lists and redirects that need
 * nothing heavier. DB-backed sessions reuse the membership read auth already
 * made (no extra query); a legacy token's claimed IDs are read once, in claim
 * order, and IDs with no site row are dropped. Empty when signed out or revoked.
 */
export const getAuthorizedSites = cache(async (): Promise<SiteSummary[]> => {
    const auth = await resolveAuth();
    if (!auth) return [];
    if (auth.sites) return auth.sites;
    if (auth.siteIds.length === 0) return [];
    const found = new Map((await new SiteRepo().getSiteSummariesByIds(auth.siteIds)).map(s => [s.id, s]));
    return auth.siteIds.flatMap(id => found.get(id) ?? []);
});

export async function getDefaultSiteId(): Promise<string | null> {
    const siteIds = await getAuthorizedSiteIds();
    return siteIds.length > 0 ? siteIds[0] : null;
}
