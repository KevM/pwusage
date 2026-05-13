import { cache } from 'react';
import { cookies } from 'next/headers';
import { verifySiteToken } from './auth-jwt';
import { getUserTokensForSite, isUserActive } from './user-repo';

const SITE_AUTH_COOKIE = 'site_auth';

export async function getTeslaCredentials() {
    const siteIds = await getAuthorizedSiteIds();
    if (siteIds.length === 0) {
        return null;
    }
    // We assume all sites provided in a single site_auth token belong to the same Tesla User
    // So we grab credentials from the first one.
    return getUserTokensForSite(siteIds[0]);
}

export const isUserAdmin = cache(async (): Promise<boolean> => {
    const user = await getCurrentUser();
    if (!user) return false;

    const cookieStore = await cookies();
    const token = cookieStore.get(SITE_AUTH_COOKIE)?.value;

    if (token) {
        const decoded = verifySiteToken(token);
        if (decoded && decoded.roles.includes('admin')) {
            return true;
        }
    }
    return false;
});

export const getCurrentUser = cache(async (): Promise<{ id: string, email?: string } | null> => {
    const cookieStore = await cookies();
    const token = cookieStore.get(SITE_AUTH_COOKIE)?.value;

    if (token) {
        const decoded = verifySiteToken(token);
        if (decoded && decoded.sub) {
            // Check if user is still active in DB
            if (!(await isUserActive(decoded.sub))) {
                console.warn(`[AuthChecks] Blocking access for revoked/inactive user: ${decoded.sub}`);
                return null;
            }
            return { id: decoded.sub };
        }
    }
    return null;
});

export const verifySiteAccess = cache(async (siteId: string): Promise<boolean> => {
    const cookieStore = await cookies();
    const token = cookieStore.get(SITE_AUTH_COOKIE)?.value;

    if (token) {
        const decoded = verifySiteToken(token);
        if (decoded && (decoded.sites.includes(siteId) || decoded.roles.includes('admin'))) {
            // Check if user is still active in DB
            if (decoded.sub && !(await isUserActive(decoded.sub))) {
                console.warn(`[AuthChecks] verifySiteAccess blocked for revoked user: ${decoded.sub}`);
                return false;
            }
            return true;
        }
    }
    return false;
});

export const getAuthorizedSiteIds = cache(async (): Promise<string[]> => {
    const cookieStore = await cookies();
    const token = cookieStore.get(SITE_AUTH_COOKIE)?.value;

    if (token) {
        const decoded = verifySiteToken(token);
        if (decoded && decoded.sites.length > 0) {
            // Check if user is still active in DB
            if (decoded.sub && !(await isUserActive(decoded.sub))) {
                console.warn(`[AuthChecks] getAuthorizedSiteIds blocked for revoked user: ${decoded.sub}`);
                return [];
            }
            return decoded.sites;
        }
    }
    return [];
});

export async function getDefaultSiteId(): Promise<string | null> {
    const siteIds = await getAuthorizedSiteIds();
    return siteIds.length > 0 ? siteIds[0] : null;
}
