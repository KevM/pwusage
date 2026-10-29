import { assertTeslaConnection } from './tesla-refresh-outcome';
import { TeslaClient } from './tesla-client';
import { UserRepo } from './user-repo';
import { SiteRepo } from './site-repo';
import { TeslaTokenRepo } from './tesla-token-repo';

export interface TeslaClientFactoryOptions {
    onTokenUpdate?: () => void;
    onBaseUrlChange?: (baseUrl: string) => void | Promise<void>;
}

/** Store a regional Fleet host Tesla pointed this user at (best effort; see TeslaClient). */
function recordFleetBaseUrl(userId: string) {
    return (baseUrl: string) => new UserRepo().setFleetApiBaseUrl(userId, baseUrl);
}

/**
 * Construct a TeslaClient for a specific site, wired with site-level locked token refresh handlers.
 * Returns null if no valid refresh_token exists for the site.
 */
export async function createTeslaClientForSite(
    siteId: string,
    options?: TeslaClientFactoryOptions
): Promise<TeslaClient | null> {
    const tokens = await new UserRepo().getTokensForSite(siteId);
    if (!tokens?.refresh_token) {
        return null;
    }
    const siteRepo = new SiteRepo();
    const tokenRepo = new TeslaTokenRepo(siteRepo);
    const handlers = tokenRepo.getLockedRefreshHandler(siteId);
    return new TeslaClient({
        accessToken: tokens.access_token || 'expired',
        beforeRequest: async () => {
            const current = await new UserRepo().getTokensForSite(siteId);
            assertTeslaConnection(current);
            if (tokens.user_id !== current?.user_id) throw new Error('Site owner changed');
        },
        refreshToken: tokens.refresh_token,
        tokenRefreshHandler: handlers.refreshHandler,
        onTokenError: handlers.errorHandler,
        onTokenUpdate: options?.onTokenUpdate,
        baseUrl: tokens.fleet_api_base_url,
        onBaseUrlChange: options?.onBaseUrlChange ?? (tokens.user_id ? recordFleetBaseUrl(tokens.user_id) : undefined)
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
    if (!userTokens?.access_token) {
        return null;
    }
    const handlers = new TeslaTokenRepo(new SiteRepo()).getLockedUserRefreshHandler(userId);
    return new TeslaClient({
        accessToken: userTokens.access_token,
        beforeRequest: async () => assertTeslaConnection(await new UserRepo().getTokens(userId)),
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
    return new TeslaClient({
        accessToken,
        beforeRequest: options?.userId ? async () => assertTeslaConnection(await new UserRepo().getTokens(options.userId!)) : undefined,
        refreshToken: refreshToken || undefined,
        onTokenUpdate: options?.onTokenUpdate,
        baseUrl: options?.baseUrl,
        onBaseUrlChange
    });
}
