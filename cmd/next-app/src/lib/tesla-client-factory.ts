import { assertTeslaConnection } from './tesla-refresh-outcome';
import { TeslaClient, type TeslaClientConfig } from './tesla-client';
import { UserRepo } from './user-repo';
import { SiteRepo } from './site-repo';
import { TeslaTokenRepo } from './tesla-token-repo';
import { siteMembershipEnabled } from './site-membership-flag';
import { requiresTeslaReconnect } from './tesla-refresh-outcome';

export interface TeslaClientFactoryOptions {
    onTokenUpdate?: () => void;
    onBaseUrlChange?: (baseUrl: string) => void | Promise<void>;
    rateLimit?: TeslaClientConfig['rateLimit'];
}

/** Store a regional Fleet host Tesla pointed this user at (best effort; see TeslaClient). */
function recordFleetBaseUrl(userId: string) {
    return (baseUrl: string) => new UserRepo().setFleetApiBaseUrl(userId, baseUrl);
}

/** Gate a Fleet request on the account's connection and hand back its stored credentials. */
async function currentTeslaConnection(userId: string) {
    const current = await new UserRepo().getTokens(userId);
    assertTeslaConnection(current);
    return current;
}

/**
 * Construct a TeslaClient for a specific site, wired with site-level locked token refresh handlers.
 * Returns null if no valid refresh_token exists for the site.
 */
export async function createTeslaClientForSite(
    siteId: string,
    options?: TeslaClientFactoryOptions
): Promise<TeslaClient | null> {
    let tokens = await new UserRepo().getTokensForSite(siteId);
    if (siteMembershipEnabled() && (!tokens?.refresh_token || tokens.is_active !== true || requiresTeslaReconnect(tokens))) {
        await new SiteRepo().repairConnection(siteId);
        tokens = await new UserRepo().getTokensForSite(siteId);
    }
    if (!tokens?.refresh_token) {
        return null;
    }
    return createPinnedMemberClient(siteId, tokens.user_id, tokens, options);
}

/** Verify or command through a particular member's grant, regardless of the site's connection. */
export async function createTeslaClientForSiteMember(
    siteId: string,
    userId: string,
    options?: TeslaClientFactoryOptions
): Promise<TeslaClient | null> {
    const tokens = await new UserRepo().getTokensForSiteMember(siteId, userId);
    if (!tokens?.refresh_token) return null;
    return createPinnedMemberClient(siteId, userId, tokens, options);
}

function createPinnedMemberClient(
    siteId: string,
    userId: string,
    tokens: { access_token: string | null; refresh_token: string; fleet_api_base_url: string | null },
    options?: TeslaClientFactoryOptions
): TeslaClient {
    const siteRepo = new SiteRepo();
    const tokenRepo = new TeslaTokenRepo(siteRepo);
    // Keep this client on the account selected at construction. A connection
    // move must not make an in-flight call adopt another member's grant.
    const handlers = tokenRepo.getLockedUserRefreshHandler(userId);
    return new TeslaClient({
        accessToken: tokens.access_token || 'expired',
        beforeRequest: async () => {
            const current = await new UserRepo().getTokensForSiteMember(siteId, userId);
            if (!current?.tesla_energy_site_id) throw new Error(`Tesla site mapping missing for ${siteId}`);
            assertTeslaConnection(current);
            return current;
        },
        requireTeslaSiteMapping: true,
        refreshToken: tokens.refresh_token,
        tokenRefreshHandler: handlers.refreshHandler,
        onTokenError: handlers.errorHandler,
        onTokenUpdate: options?.onTokenUpdate,
        baseUrl: tokens.fleet_api_base_url,
        onBaseUrlChange: options?.onBaseUrlChange ?? recordFleetBaseUrl(userId),
        rateLimit: options?.rateLimit,
    });
}

/**
 * Construct a TeslaClient for a specific user ID using their account tokens.
 * Returns null if the user has no tokens.
 */
export async function createTeslaClientForUser(
    userId: string,
    options?: TeslaClientFactoryOptions
): Promise<TeslaClient | null> {
    const userTokens = await new UserRepo().getTokens(userId);
    if (!userTokens?.refresh_token) {
        return null;
    }
    const handlers = new TeslaTokenRepo(new SiteRepo()).getLockedUserRefreshHandler(userId);
    return new TeslaClient({
        accessToken: userTokens.access_token || 'expired',
        beforeRequest: () => currentTeslaConnection(userId),
        refreshToken: userTokens.refresh_token || undefined,
        tokenRefreshHandler: handlers.refreshHandler,
        onTokenError: handlers.errorHandler,
        onTokenUpdate: options?.onTokenUpdate,
        baseUrl: userTokens.fleet_api_base_url,
        onBaseUrlChange: options?.onBaseUrlChange ?? recordFleetBaseUrl(userId)
    });
}

/**
 * Construct a TeslaClient directly from an access token and optional refresh token.
 * Pass `userId` when the token belongs to a user so a learned regional host is stored.
 */
export function createTeslaClientForAccessToken(
    accessToken: string,
    refreshToken?: string,
    options?: TeslaClientFactoryOptions & { baseUrl?: string | null; userId?: string }
): TeslaClient {
    const onBaseUrlChange = options?.onBaseUrlChange
        ?? (options?.userId ? recordFleetBaseUrl(options.userId) : undefined);
    // An account's grant is only ever refreshed through its lease.
    const handlers = options?.userId ? new TeslaTokenRepo(new SiteRepo()).getLockedUserRefreshHandler(options.userId) : undefined;
    return new TeslaClient({
        accessToken,
        beforeRequest: options?.userId ? () => currentTeslaConnection(options.userId!) : undefined,
        refreshToken: refreshToken || undefined,
        tokenRefreshHandler: handlers?.refreshHandler,
        onTokenError: handlers?.errorHandler,
        onTokenUpdate: options?.onTokenUpdate,
        baseUrl: options?.baseUrl,
        onBaseUrlChange
    });
}
