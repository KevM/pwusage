import { Site, SiteWithTariffs, TrmnlInstallation } from './db';
import { TeslaClient, TeslaClientConfig, isTeslaAuthError } from './tesla-client';
import { SiteRepo } from './site-repo';
import { verifySiteToken } from './auth-jwt';
import { UserRepo, UserAuthState } from './user-repo';
import { createEnergyRepo } from './energy-repo-factory';
import { EnergyRepo, UsageData } from './energy-repo';
import { TeslaTokenRepo } from './tesla-token-repo';
import { TrmnlService } from './trmnl-service';
import { Importer } from './importer';
import { Schedule } from './schedule';
import { getCurrentCycleStart, getNextCycleStart } from './billing-cycle';
import {
    getSiteTodayMidnight,
    safeParseSiteLocalDateToMidnight,
    addMonthsInSiteTimezone,
    getSiteLocalComponents,
    formatSiteDate
} from './date-utils';

export interface SiteServiceDeps {
    teslaClient?: Pick<TeslaClient, 'getProducts'>;
    siteRepo: SiteRepo;
    siteAuthToken?: string;
    // DB auth-state resolution (active status + session_version + roles).
    // Defaults to the real UserRepo.getAuthState; injectable for tests.
    getAuthState?: (userId: string) => Promise<UserAuthState | null>;
    energyRepo?: Pick<EnergyRepo, 'hasData' | 'getUsageByTOU'>;
    teslaTokenRepo?: Pick<TeslaTokenRepo, 'getLockedRefreshHandler'>;
    trmnlService?: Pick<TrmnlService, 'getInstallationBySiteId'>;
    teslaClientCreator?: (config: TeslaClientConfig) => TeslaClient;
    importerCreator?: (client: TeslaClient) => Pick<Importer, 'ensureSite'>;
}

export type SitePageDataResult =
    | { status: 'unauthorized' }
    | { status: 'auth-failure' }
    | { status: 'not-found' }
    | { status: 'needs-setup'; siteId: string }
    | {
        status: 'ready';
        site: SiteWithTariffs;
        installation: TrmnlInstallation | undefined;
        billingDay: number;
        prevDateStr: string;
        nextDateStr: string;
        isCurrentPeriod: boolean;
        dateRangeLabel: string;
        currentMonthVal: string;
        fullBillDateStr: string;
        usage: UsageData[];
        activeTariffId: number | undefined;
        activeTouName: string | undefined;
        currencySymbol: string;
        dateStr: string;
        start: Date;
        end: Date;
        refDate: Date;
      };

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
                // or a session revoked by sign-out-everywhere would otherwise keep
                // access until the token expires. Re-check against the DB.
                if (decoded.sub) {
                    const authState = await this.getAuthState(decoded.sub);
                    if (!authState || !authState.isActive) {
                        console.warn(`[SiteService] getAuthorizedSites blocked for revoked/inactive user: ${decoded.sub}`);
                        throw new Error('Unauthorized: Revoked or inactive user');
                    }
                    if ((decoded.sv ?? 0) < authState.sessionVersion) {
                        console.warn(`[SiteService] getAuthorizedSites blocked revoked session for user ${decoded.sub} (token sv=${decoded.sv ?? 0} < db sv=${authState.sessionVersion})`);
                        throw new Error('Unauthorized: Revoked session');
                    }
                    // Close stale claims: derive site membership from the DB, not the JWT.
                    const userSites = await this.deps.siteRepo.getSitesForUser(decoded.sub);
                    authorizedSiteIds = new Set(userSites.map(s => s.id));
                } else {
                    authorizedSiteIds = new Set(decoded.sites);
                }
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

    async loadSitePageData(siteId: string, queryDate?: string): Promise<SitePageDataResult> {
        const hasAccess = await this.validateSiteAccess(siteId);
        if (!hasAccess) {
            return { status: 'unauthorized' };
        }

        const siteRepo = this.deps.siteRepo;
        const teslaTokenRepo = this.deps.teslaTokenRepo || new TeslaTokenRepo(siteRepo);
        const trmnlService = this.deps.trmnlService || new TrmnlService();

        let site = await siteRepo.getSite(siteId, { includeTokens: true });
        const energyRepo = this.deps.energyRepo || createEnergyRepo(site?.timezone??'UTC');

        const accessToken = site?.access_token;
        const refreshToken = site?.refresh_token;

        const ownerId = site?.user_id;
        const handlers = teslaTokenRepo.getLockedRefreshHandler(siteId);
        // Tokens are absent when the site row is missing or the user has no
        // stored credentials. We still build the client and attempt ensureSite:
        // the empty token earns a 401 -> TeslaAuthError -> the 'auth-failure'
        // status below, which is the page's re-auth prompt. Intentional, not
        // accidental — do not "fix" by short-circuiting before ensureSite
        // (tests pin that the recovery attempt happens).
        const config: TeslaClientConfig = {
            accessToken: accessToken ?? '',
            refreshToken: refreshToken ?? undefined,
            tokenRefreshHandler: handlers.refreshHandler,
            onTokenError: handlers.errorHandler,
            onTokenUpdate: async () => {
                console.log('Token update callback triggered (Site Page Service).');
            },
            baseUrl: site?.fleet_api_base_url,
            onBaseUrlChange: ownerId ? (baseUrl) => new UserRepo().setFleetApiBaseUrl(ownerId, baseUrl) : undefined
        };

        const teslaClient = this.deps.teslaClientCreator
            ? this.deps.teslaClientCreator(config)
            : new TeslaClient(config);

        const importer = this.deps.importerCreator
            ? this.deps.importerCreator(teslaClient)
            : new Importer(teslaClient);

        try {
            if (!site) {
                console.log(`[SitePageData] Site ${siteId} missing in DB, running ensureSite...`);
                const ensureResult = await importer.ensureSite(siteId);
                if (ensureResult) {
                    site = ensureResult;
                }
            }
        } catch (error) {
            console.error('Failed to ensure site:', error);
            if (isTeslaAuthError(error)) {
                console.log('Returning auth-failure due to auth failure...');
                return { status: 'auth-failure' };
            }

            const hasData = await energyRepo.hasData(siteId);
            if (!hasData) {
                throw error;
            }
        }

        const hasData = await energyRepo.hasData(siteId);

        if (!hasData && site) {
            try {
                await importer.ensureSite(siteId);
            } catch (error) {
                console.error('Failed to ensure site on ghost-site recovery:', error);
                if (isTeslaAuthError(error)) {
                    return { status: 'auth-failure' };
                }
                throw error;
            }
        }

        const finalSite = await siteRepo.getSite(siteId);

        if (!finalSite) {
            return { status: 'not-found' };
        }

        if (!hasData) {
            return { status: 'needs-setup', siteId };
        }

        const siteJson = finalSite.json as import('@/lib/tesla-client').EnergySiteInfo | null;
        const currencyCode = siteJson?.tariff_content_v2?.currency || 'USD';
        let currencySymbol = '$';
        if (currencyCode === 'GBP') {
            currencySymbol = '£';
        } else if (currencyCode === 'EUR') {
            currencySymbol = '€';
        }

        const siteNow = getSiteTodayMidnight(finalSite.timezone);
        let refDate = siteNow;
        let dateStr = formatSiteDate(siteNow, finalSite.timezone);

        if (queryDate) {
            const parsed = safeParseSiteLocalDateToMidnight(queryDate, finalSite.timezone);
            if (parsed) {
                refDate = parsed;
                dateStr = queryDate;
            }
        }

        const billingDay = finalSite.billing_start_day || 1;
        const start = getCurrentCycleStart(billingDay, refDate, finalSite.timezone);
        const end = getNextCycleStart(billingDay, start, finalSite.timezone);

        const usage = await (this.deps.energyRepo || createEnergyRepo(finalSite.timezone)).getUsageByTOU(siteId, start, end);

        let activeTariffId: number | undefined;
        let activeTouName: string | undefined;
        if (finalSite.tariffs && finalSite.tariffs.length > 0) {
            const schedule = new Schedule(finalSite.tariffs, finalSite.timezone);
            const tariffPeriod = schedule.getTariffPeriod(new Date());
            if (tariffPeriod) {
                activeTariffId = tariffPeriod.tariff.id;
                activeTouName = tariffPeriod.schedule.name || undefined;
            }
        }

        const prevDate = addMonthsInSiteTimezone(start, -1, finalSite.timezone);
        const nextDate = end;

        const startComponents = getSiteLocalComponents(start, finalSite.timezone);
        const endComponents = getSiteLocalComponents(end, finalSite.timezone);

        const getDisplayLabel = (comps: { year: number; month: number; day: number }, includeYear: boolean) => {
            const mNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
            if (includeYear) return `${mNames[comps.month - 1]} ${comps.day}, ${comps.year}`;
            return `${mNames[comps.month - 1]} ${comps.day}`;
        };

        const dateRangeLabel = `${getDisplayLabel(startComponents, false)} - ${getDisplayLabel(endComponents, true)}`;
        const currentMonthVal = `${startComponents.year}-${String(startComponents.month).padStart(2, '0')}`;
        const fullBillDateStr = `${startComponents.year}-${String(startComponents.month).padStart(2, '0')}-${String(billingDay).padStart(2, '0')}`;

        const isCurrentPeriod = siteNow >= start && siteNow < end;

        const installation = await trmnlService.getInstallationBySiteId(finalSite.id, { includeTokens: false });

        return {
            status: 'ready',
            site: finalSite,
            installation,
            billingDay,
            prevDateStr: formatSiteDate(prevDate, finalSite.timezone),
            nextDateStr: formatSiteDate(nextDate, finalSite.timezone),
            isCurrentPeriod,
            dateRangeLabel,
            currentMonthVal,
            fullBillDateStr,
            usage,
            activeTariffId,
            activeTouName,
            currencySymbol,
            dateStr,
            start,
            end,
            refDate
        };
    }

    async validateSiteAccess(siteId: string): Promise<boolean> {
        // 1. Fast, offline check
        if (this.deps.siteAuthToken) {
            const decoded = verifySiteToken(this.deps.siteAuthToken);
            if (decoded) {
                if (decoded.sub) {
                    // The JWT claims are trusted offline, so a revoked/deactivated
                    // user or a session revoked by sign-out-everywhere would
                    // otherwise keep access until the token expires. Re-check.
                    const authState = await this.getAuthState(decoded.sub);
                    if (!authState || !authState.isActive) {
                        console.warn(`[SiteService] validateSiteAccess blocked for revoked/inactive user: ${decoded.sub}`);
                        return false;
                    }
                    if ((decoded.sv ?? 0) < authState.sessionVersion) {
                        console.warn(`[SiteService] validateSiteAccess blocked revoked session for user ${decoded.sub} (token sv=${decoded.sv ?? 0} < db sv=${authState.sessionVersion})`);
                        return false;
                    }
                    // Close stale claims: authorize from DB roles + DB site membership.
                    if (authState.roles.includes('admin')) {
                        return true;
                    }
                    const userSites = await this.deps.siteRepo.getSitesForUser(decoded.sub);
                    return userSites.some(s => s.id === siteId);
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

    private async getAuthState(userId: string): Promise<UserAuthState | null> {
        const resolveAuthState = this.deps.getAuthState;
        if (resolveAuthState) return resolveAuthState(userId);
        return new UserRepo().getAuthState(userId);
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
