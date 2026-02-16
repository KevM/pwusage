import { cookies } from 'next/headers';
import { verifySiteToken } from './auth-jwt';
import { getUserTokensForSite } from './energy-repo';

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

export async function isUserAdmin(): Promise<boolean> {
    const cookieStore = await cookies();
    const token = cookieStore.get(SITE_AUTH_COOKIE)?.value;

    if (token) {
        const decoded = verifySiteToken(token);
        if (decoded && decoded.roles.includes('admin')) {
            return true;
        }
    }
    return false;
    return false;
}

export async function getCurrentUser(): Promise<{ id: string, email?: string } | null> {
    const cookieStore = await cookies();
    const token = cookieStore.get(SITE_AUTH_COOKIE)?.value;

    if (token) {
        const decoded = verifySiteToken(token);
        // Assuming the ID is in the subject 'sub' claim or similar. 
        // Based on `signSiteToken`, verify what's actually in there. 
        // The `verifySiteToken` usually returns { sites: [], roles: [], sub: 'userid', ... }
        if (decoded && decoded.sub) {
            return { id: decoded.sub };
        }
    }
    return null;
}

export async function verifySiteAccess(siteId: string): Promise<boolean> {
    const cookieStore = await cookies();
    const token = cookieStore.get(SITE_AUTH_COOKIE)?.value;

    if (token) {
        const decoded = verifySiteToken(token);
        if (decoded && (decoded.sites.includes(siteId) || decoded.roles.includes('admin'))) {
            return true;
        }
    }
    return false;
}

export async function getAuthorizedSiteIds(): Promise<string[]> {
    const cookieStore = await cookies();
    const token = cookieStore.get(SITE_AUTH_COOKIE)?.value;

    if (token) {
        const decoded = verifySiteToken(token);
        if (decoded && decoded.sites.length > 0) {
            return decoded.sites;
        }
    }
    return [];
}

export async function getDefaultSiteId(): Promise<string | null> {
    const siteIds = await getAuthorizedSiteIds();
    return siteIds.length > 0 ? siteIds[0] : null;
}
