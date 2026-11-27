import { assertTeslaConnection, isTeslaConnectionRequired } from './tesla-refresh-outcome';
import { Site, SiteWithTariffs, TrmnlInstallation } from './db';
import { TeslaClient, TeslaClientConfig, isTeslaAuthError } from './tesla-client';
import { SiteRepo } from './site-repo';
import { validateSessionAgainstAuthState, verifySiteToken } from './auth-jwt';
import { UserRepo, UserAuthState } from './user-repo';
import { createEnergyRepo } from './energy-repo-factory';
import { EnergyRepo, UsageData } from './energy-repo';
import { TeslaTokenRepo } from './tesla-token-repo';
import { TrmnlService } from './trmnl-service';
import { Importer } from './importer';
import { logSessionRejection } from './observability';
import { Schedule } from './schedule';
import { getCurrentCycleStart, getNextCycleStart } from './billing-cycle';
import type { SiteSettingsSection } from './site-settings';
import { DEFAULT_SITE_TAB, type SiteTabId } from './site-tabs';
import { readMobileHistoryRevision } from './mobile-history-revision';
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
    teslaTokenRepo?: Pick<TeslaTokenRepo, 'getLockedUserRefreshHandler'>;
    trmnlService?: Pick<TrmnlService, 'getInstallationsBySiteId'>;
    teslaClientCreator?: (config: TeslaClientConfig) => TeslaClient;
    importerCreator?: (client: TeslaClient) => Pick<Importer, 'ensureSite'>;
    /** Stored-history revision of a range; defaults to `readMobileHistoryRevision`. */
    readHistoryRevision?: (siteId: string, start: Date, end: Date) => Promise<string>;
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
        /** Read only for the Connections settings page; null otherwise. */
        installations: TrmnlInstallation[] | null;
        billingDay: number;
        prevDateStr: string;
        nextDateStr: string;
        isCurrentPeriod: boolean;
        dateRangeLabel: string;
        currentMonthVal: string;
        fullBillDateStr: string;
        /** Read only for the Estimated Bill tab; null otherwise. */
        usage: UsageData[] | null;
        /**
         * Stored-history revision of the billing period, read before `usage`
         * (bill only). Sync compares it with the current one to know whether
         * the rendered bill is outdated, including by another tab's import.
         */
        historyRevision: string | null;
        activeTariffId: number | undefined;
        activeTouName: string | undefined;
        currencySymbol: string;
        dateStr: string;
        start: Date;
        end: Date;
        refDate: Date;
      };

export interface SitePageDataOptions {
    /** The selected tab. Each tab reads only what it shows; defaults to the bill. */
    view?: SiteTabId;
    settingsSection?: SiteSettingsSection | null;
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
                // or a session revoked by sign-out-everywhere would otherwise keep
                // access until the token expires. Re-check against the DB.
                if (decoded.sub) {
                    const authState = await this.getAuthState(decoded.sub);
                    const rejection = validateSessionAgainstAuthState(
                        { sub: decoded.sub, sv: decoded.sv, orig_iat: decoded.orig_iat },
                        authState
                    );
                    if (rejection) {
                        logSessionRejection(rejection, decoded.sub);
                        if (rejection === 'revoked-session') {
                            console.warn(`[SiteService] getAuthorizedSites blocked revoked session for user ${decoded.sub}`);
                            throw new Error('Unauthorized: Revoked session');
                        }
                        console.warn(`[SiteService] getAuthorizedSites blocked for revoked/inactive user: ${decoded.sub}`);
                        throw new Error('Unauthorized: Revoked or inactive user');
                    }
                    // Close stale claims: derive site membership from the DB, not the JWT.
                    // The user-scoped query already returns the rows, so no second read.
                    return this.deps.siteRepo.getSitesForUser(decoded.sub, { includeJson: options?.includeJson });
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

        // Legacy tokens and the Tesla fallback: read only the authorized rows.
        if (authorizedSiteIds.size === 0) return [];
        return this.deps.siteRepo.getSitesByIds([...authorizedSiteIds], { includeJson: options?.includeJson });
    }

    async loadSitePageData(siteId: string, queryDate?: string, options: SitePageDataOptions = {}): Promise<SitePageDataResult> {
        const view = options.view ?? DEFAULT_SITE_TAB;
        const hasAccess = await this.validateSiteAccess(siteId);
        if (!hasAccess) {
            return { status: 'unauthorized' };
        }

        const siteRepo = this.deps.siteRepo;
        const teslaTokenRepo = this.deps.teslaTokenRepo || new TeslaTokenRepo();
        const trmnlService = this.deps.trmnlService || new TrmnlService();

        let site = await siteRepo.getSite(siteId, { includeTokens: true });
        const energyRepo = this.deps.energyRepo || createEnergyRepo(site?.timezone??'UTC');

        const accessToken = site?.access_token;
        const refreshToken = site?.refresh_token;

        // The selected Tesla connection's member, which can differ from the legacy owner.
        const ownerId = site?.token_owner_id ?? undefined;
        const handlers = ownerId ? teslaTokenRepo.getLockedUserRefreshHandler(ownerId) : null;
        // Tokens are absent when the site row is missing or the user has no
        // stored credentials. We still build the client and attempt ensureSite:
        // the empty token earns a 401 -> TeslaAuthError -> the 'auth-failure'
        // status below, which is the page's re-auth prompt. Intentional, not
        // accidental — do not "fix" by short-circuiting before ensureSite
        // (tests pin that the recovery attempt happens).
        const config: TeslaClientConfig = {
            accessToken: accessToken ?? '',
            beforeRequest: async () => {
                const current = ownerId ? await new UserRepo().getTokensForSiteMember(siteId, ownerId) : null;
                assertTeslaConnection(current);
                if (!current?.tesla_energy_site_id) throw new Error(`Tesla site mapping missing for ${siteId}`);
                return current;
            },
            requireTeslaSiteMapping: true,
            refreshToken: refreshToken ?? undefined,
            tokenRefreshHandler: handlers?.refreshHandler,
            onTokenError: handlers?.errorHandler,
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
            if (isTeslaAuthError(error) || isTeslaConnectionRequired(error)) {
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
                if (isTeslaAuthError(error) || isTeslaConnectionRequired(error)) {
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

        // Revision first: a write between the two reads then only costs one extra refresh.
        const historyRevision = view === 'bill' ? await this.readHistoryRevision(siteId, start, end) : null;
        const usage = view === 'bill'
            ? await (this.deps.energyRepo || createEnergyRepo(finalSite.timezone)).getUsageByTOU(siteId, start, end)
            : null;

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

        const installations = view === 'settings' && options.settingsSection === 'connections'
            ? await trmnlService.getInstallationsBySiteId(finalSite.id, { includeTokens: false })
            : null;
        const installation = installations?.[0];

        return {
            status: 'ready',
            site: finalSite,
            installation,
            installations,
            billingDay,
            prevDateStr: formatSiteDate(prevDate, finalSite.timezone),
            nextDateStr: formatSiteDate(nextDate, finalSite.timezone),
            isCurrentPeriod,
            dateRangeLabel,
            currentMonthVal,
            fullBillDateStr,
            usage,
            historyRevision,
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
                    // user, a session revoked by sign-out-everywhere, or a token
                    // predating a recreated account would otherwise keep access.
                    const authState = await this.getAuthState(decoded.sub);
                    const rejection = validateSessionAgainstAuthState(
                        { sub: decoded.sub, sv: decoded.sv, orig_iat: decoded.orig_iat },
                        authState
                    );
                    if (rejection || !authState) {
                        logSessionRejection(rejection ?? 'missing-account', decoded.sub);
                        console.warn(`[SiteService] validateSiteAccess blocked session for user ${decoded.sub}: ${rejection}`);
                        return false;
                    }
                    // Close stale claims: authorize from DB roles + DB site membership.
                    if (authState.roles.includes('admin')) {
                        return true;
                    }
                    const userSites = await this.deps.siteRepo.getSitesForUser(decoded.sub);
                    const allowed = userSites.some(s => s.id === siteId);
                    if (!allowed) logSessionRejection('site-not-assigned', decoded.sub);
                    return allowed;
                }
                if (decoded.roles.includes('admin')) {
                    return true;
                }
                const allowed = decoded.sites.includes(siteId);
                if (!allowed) logSessionRejection('site-not-assigned');
                return allowed;
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

        if (!this.deps.siteAuthToken) logSessionRejection('missing-cookie');
        return false;
    }

    private async readHistoryRevision(siteId: string, start: Date, end: Date): Promise<string | null> {
        try {
            return this.deps.readHistoryRevision
                ? await this.deps.readHistoryRevision(siteId, start, end)
                : (await readMobileHistoryRevision(siteId, start, end)).revision;
        } catch (error) {
            // Sync still refreshes on its own writes without it.
            console.warn(`[SiteService] history revision unavailable for ${siteId}:`, error);
            return null;
        }
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
        const teslaIds = products
            .filter(p => p.energy_site_id !== undefined && p.energy_site_id !== null)
            .map(p => p.energy_site_id!.toString());
        return new Set(await this.deps.siteRepo.getSiteIdsForTeslaIds(teslaIds));
    }
}
