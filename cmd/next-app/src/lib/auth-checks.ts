import { cookies } from 'next/headers';
import { TeslaClient } from './tesla-client';
import { signSiteToken, verifySiteToken } from './auth-jwt';
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

    // Fallback: Fetch fresh list from Tesla API
    const accessToken = cookieStore.get('access_token')?.value;
    if (!accessToken) return false;

    try {
        const client = new TeslaClient({ accessToken });
        const products = await client.getProducts();
        const allowedSites = products
            .filter(p => p.energy_site_id)
            .map(p => p.energy_site_id!.toString());

        // Update cookie (using centralized auth logic)
        await setSiteClaims(allowedSites);

        return allowedSites.includes(siteId);
    } catch {
        // Log error but don't leak details
        console.error('Failed to verify site access with Tesla API');
        return false;
    }
}

export async function getAuthorizedSiteIds(): Promise<string[]> {
    const cookieStore = await cookies();
    const token = cookieStore.get(SITE_AUTH_COOKIE)?.value;

    // 1. Try from Cookie
    if (token) {
        const decoded = verifySiteToken(token);
        if (decoded && decoded.sites.length > 0) {
            return decoded.sites;
        }
    }

    // 2. Fallback: Fetch from API
    const accessToken = cookieStore.get('access_token')?.value;
    if (accessToken) {
        try {
            const client = new TeslaClient({ accessToken });
            const products = await client.getProducts();
            const allowedSites = products
                .filter(p => p.energy_site_id)
                .map(p => p.energy_site_id!.toString());

            if (allowedSites.length > 0) {
                // Update cookie cache
                await setSiteClaims(allowedSites);
                return allowedSites;
            }
        } catch (e) {
            console.error('Failed to get authorized sites:', e);
        }
    }

    return [];
}

export async function getDefaultSiteId(): Promise<string | null> {
    const siteIds = await getAuthorizedSiteIds();
    return siteIds.length > 0 ? siteIds[0] : null;
}

export async function setSiteClaims(siteIds: string[]) {
    // We name this setSiteClaims to keep backward compat if imported elsewhere, 
    // but it sets the authoritative site_auth cookie.
    const token = signSiteToken(siteIds);
    const cookieStore = await cookies();
    try {
        cookieStore.set(SITE_AUTH_COOKIE, token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            maxAge: 86400 // 24 hours
        });
    } catch {
        // Ignored: Cannot set cookies in Server Components if headers sent
    }
}
