import jwt from 'jsonwebtoken';

const AUTH_SECRET = process.env.AUTH_SECRET || 'default-dev-secret-do-not-use-in-prod';

export interface SiteAuthClaims {
    sites: string[];
}

export function signSiteToken(siteIds: string[]): string {
    return jwt.sign({ sites: siteIds }, AUTH_SECRET, {
        expiresIn: '24h' // Match typical session length or refresh cycle
    });
}

export function verifySiteToken(token: string): string[] | null {
    try {
        const decoded = jwt.verify(token, AUTH_SECRET) as SiteAuthClaims;
        if (decoded && Array.isArray(decoded.sites)) {
            return decoded.sites;
        }
        return null;
    } catch (e) {
        return null;
    }
}
