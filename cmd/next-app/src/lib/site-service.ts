import { Site } from './db';
import { TeslaClient } from './tesla-client';
import { EnergyRepo } from './energy-repo';
import { verifySiteToken } from './auth-jwt';

export interface SiteServiceDeps {
    teslaClient?: Pick<TeslaClient, 'getProducts'>;
    energyRepo: Pick<EnergyRepo, 'getSites'>;
    siteAuthToken?: string;
}

export class SiteService {
    constructor(private deps: SiteServiceDeps) { }

    async getAuthorizedSites(): Promise<Site[]> {
        let authorizedSiteIds: Set<string>;

        // 1. Try to use cached JWT source of truth
        if (this.deps.siteAuthToken) {
            const decoded = verifySiteToken(this.deps.siteAuthToken);
            if (decoded) {
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
        const allSites = await this.deps.energyRepo.getSites();



        // Filter sites to only those the user is authorized for
        return allSites.filter(s => authorizedSiteIds.has(s.id));
    }

    async validateSiteAccess(siteId: string): Promise<boolean> {
        // 1. Fast, offline check
        if (this.deps.siteAuthToken) {
            const decoded = verifySiteToken(this.deps.siteAuthToken);
            if (decoded) {
                if (decoded.roles.includes('admin')) {
                    return true;
                }
                if (decoded.sites.includes(siteId)) {
                    return true;
                }
            }
        }

        // 2. Fallback to API (source of truth)
        console.log(`[SiteService] Validating access for ${siteId} against API...`);
        const authorizedIds = await this.fetchSitesFromApi();
        return authorizedIds.has(siteId);
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
