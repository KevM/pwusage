import { TeslaClient } from './tesla-client';
import { UserRepo } from './user-repo';
import { SiteRepo } from './site-repo';
import { TeslaTokenRepo } from './tesla-token-repo';

export interface TeslaClientFactoryOptions {
    onTokenUpdate?: () => void;
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
        refreshToken: tokens.refresh_token,
        tokenRefreshHandler: handlers.refreshHandler,
        onTokenError: handlers.errorHandler,
        onTokenUpdate: options?.onTokenUpdate
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
    return new TeslaClient({
        accessToken: userTokens.access_token,
        refreshToken: userTokens.refresh_token || undefined,
        onTokenUpdate: options?.onTokenUpdate
    });
}

/**
 * Construct a TeslaClient directly from an access token and optional refresh token.
 */
export function createTeslaClientForAccessToken(
    accessToken: string,
    refreshToken?: string,
    options?: TeslaClientFactoryOptions
): TeslaClient {
    return new TeslaClient({
        accessToken,
        refreshToken: refreshToken || undefined,
        onTokenUpdate: options?.onTokenUpdate
    });
}
