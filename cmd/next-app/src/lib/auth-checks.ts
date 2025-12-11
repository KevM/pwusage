import { cookies } from 'next/headers';
import jwt from 'jsonwebtoken';
import { TeslaClient } from './tesla-client';

const SITE_CLAIMS_COOKIE = 'site_claims';
const SECRET = process.env.TESLA_OAUTH_SECRET || 'dev-secret-do-not-use-in-prod';

export async function verifySiteAccess(siteId: string): Promise<boolean> {
    const cookieStore = await cookies();
    const token = cookieStore.get(SITE_CLAIMS_COOKIE)?.value;

    if (token) {
        try {
            const decoded = jwt.verify(token, SECRET) as { sites: string[] };
            if (decoded.sites.includes(siteId)) {
                return true;
            }
        } catch {
            // Invalid token, ignore and fall back to refresh
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
            .map(p => p.energy_site_id.toString());

        // Update cookie
        await setSiteClaims(allowedSites);

        return allowedSites.includes(siteId);
    } catch (e) {
        console.error('Failed to verify site access with Tesla API', e);
        return false;
    }
}

export async function setSiteClaims(siteIds: string[]) {
    const token = jwt.sign({ sites: siteIds }, SECRET, { expiresIn: '1h' });
    const cookieStore = await cookies();
    try {
        cookieStore.set(SITE_CLAIMS_COOKIE, token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            maxAge: 3600 // 1 hour
        });
    } catch {
        // Ignored: Cannot set cookies in Server Components
        // Ignored: Cannot set cookies in Server Components
        // console.debug('Unable to cache site claims (likely in Server Component)', (e as Error).message);
    }
}
