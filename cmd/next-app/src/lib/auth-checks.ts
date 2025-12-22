import { cookies } from 'next/headers';
import { TeslaClient } from './tesla-client';
import { signSiteToken, verifySiteToken } from './auth-jwt';

const SITE_AUTH_COOKIE = 'site_auth';

export async function verifySiteAccess(siteId: string): Promise<boolean> {
    const cookieStore = await cookies();
    const token = cookieStore.get(SITE_AUTH_COOKIE)?.value;

    if (token) {
        const sites = verifySiteToken(token);
        if (sites && sites.includes(siteId)) {
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
