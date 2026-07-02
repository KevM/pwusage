import { Site } from './db';
import { TeslaClient } from './tesla-client';
import { SiteRepo } from './site-repo';
import { verifySiteToken } from './auth-jwt';
import { isUserActive as defaultIsUserActive } from './user-repo';

export interface SiteServiceDeps {
    teslaClient?: Pick<TeslaClient, 'getProducts'>;
    siteRepo: Pick<SiteRepo, 'getSites'>;
    siteAuthToken?: string;
    // Revocation check. Defaults to the real (React-cached) isUserActive; injectable for tests.
    isUserActive?: (userId: string) => Promise<boolean>;
}

interface AuthorizedSitesOptions {
    includeJson?: boolean;
}

export class SiteService {
    constructor(private deps: SiteServiceDeps) { }

    async getAuthorizedSites(options?: AuthorizedSitesOptions): Promise<Site[]> {
        let authorizedSiteIds: Set<string>;

        // 1. Try to use cached JWT source of truth
        if (this.deps.siteAuthToken) {
            const decoded = verifySiteToken(this.deps.siteAuthToken);
            if (decoded) {
                // The JWT claims are trusted offline, so a revoked/deactivated user
                // would otherwise keep access until the token expires. Re-check.
                if (decoded.sub && !(await this.isUserStillActive(decoded.sub))) {
                    console.warn(`[SiteService] getAuthorizedSites blocked for revoked/inactive user: ${decoded.sub}`);
                    return [];
                }
                // console.log('[SiteService] Using JWT for authorization');
                authorizedSiteIds = new Set(decoded.sites);
            } else {
                console.warn('[SiteService] Invalid or expired siteAuthToken');
                // If we have a client (e.g. legacy/preview flow), we could fallback, but for strict JWT mode we might fail.
                // For smooth migration, if client exists, try it.
                if (this.deps.teslaClient) {
                    authorizedSiteIds = await this.fetchSitesFromApi();
                } else {
                    throw new Error('Unauthorized: Invalid site token');
                }
            }
        } else {
            if (this.deps.teslaClient) {
                console.log('[SiteService] No siteAuthToken provided, falling back to API');
                authorizedSiteIds = await this.fetchSitesFromApi();
            } else {
                throw new Error('Unauthorized: No authentication provided');
            }
        }

        // Fetch all known sites from DB
        const allSites = await this.deps.siteRepo.getSites({ includeJson: options?.includeJson });



        // Filter sites to only those the user is authorized for
        return allSites.filter(s => authorizedSiteIds.has(s.id));
    }

    async validateSiteAccess(siteId: string): Promise<boolean> {
        // 1. Fast, offline check
        if (this.deps.siteAuthToken) {
            const decoded = verifySiteToken(this.deps.siteAuthToken);
            if (decoded) {
                // The JWT claims are trusted offline, so a revoked/deactivated user
                // would otherwise keep access until the token expires. Re-check.
                if (decoded.sub && !(await this.isUserStillActive(decoded.sub))) {
                    console.warn(`[SiteService] validateSiteAccess blocked for revoked/inactive user: ${decoded.sub}`);
                    return false;
                }
                if (decoded.roles.includes('admin')) {
                    return true;
                }
                return decoded.sites.includes(siteId);
            }
        }

        // 2. Fallback to API (source of truth) only if we have a client and no valid JWT was verified
        if (this.deps.teslaClient) {
            console.log(`[SiteService] Validating access for ${siteId} against API...`);
            try {
                const authorizedIds = await this.fetchSitesFromApi();
                return authorizedIds.has(siteId);
            } catch (err) {
                console.error(`[SiteService] Failed to validate site access via API:`, err);
                return false;
            }
        }

        return false;
    }

    private async isUserStillActive(userId: string): Promise<boolean> {
        const isUserActive = this.deps.isUserActive ?? defaultIsUserActive;
        return isUserActive(userId);
    }

    private async fetchSitesFromApi(): Promise<Set<string>> {
        if (!this.deps.teslaClient) {
            throw new Error('Internal Error: Attempted to fetch from API without Tesla Client');
        }
        const products = await this.deps.teslaClient.getProducts();
        return new Set(
            products
                .filter(p => p.energy_site_id !== undefined && p.energy_site_id !== null)
                .map(p => p.energy_site_id?.toString() || '')
                .filter(id => id !== '')
        );
    }
}
