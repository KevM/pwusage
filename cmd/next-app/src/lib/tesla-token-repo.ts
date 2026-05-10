import { pool } from './db';
import { SiteRepo } from './site-repo';

export class TeslaTokenRepo {
    constructor(private siteRepo: SiteRepo) {}

    async updateSiteTokens(siteId: string, accessToken: string, refreshToken: string) {
        const site = await this.siteRepo.getSite(siteId);

        if (site && site.user_id) {
            await pool.query('UPDATE "User" SET access_token = $1, refresh_token = $2 WHERE id = $3', [accessToken, refreshToken, site.user_id]);
            console.log(`[TeslaTokenRepo] Updated tokens for USER ${site.user_id} (via site ${siteId})`);
        } else {
            console.warn(`[TeslaTokenRepo] Cannot update tokens for site ${siteId} - No User Linked!`);
        }

        this.siteRepo.invalidateCache(siteId);
    }

    async acquireRefreshLock(siteId: string): Promise<boolean> {
        const now = Date.now();
        const expires = now + 60000;

        const site = await this.siteRepo.getSite(siteId);
        if (site && site.user_id) {
            const result = await pool.query(`
                UPDATE "User"
                SET is_refreshing = 1, refresh_lock_expires = $1
                WHERE id = $2 AND (is_refreshing = 0 OR refresh_lock_expires < $3)
            `, [expires, site.user_id, now]);
            return (result.rowCount ?? 0) > 0;
        }

        return false;
    }

    async releaseRefreshLock(siteId: string) {
        const site = await this.siteRepo.getSite(siteId);
        if (site && site.user_id) {
            await pool.query('UPDATE "User" SET is_refreshing = 0, refresh_lock_expires = 0 WHERE id = $1', [site.user_id]);
        }
    }

    async waitForTokenRefresh(siteId: string, timeoutMs = 20000): Promise<{ access_token: string; refresh_token: string }> {
        const start = Date.now();
        const site = await this.siteRepo.getSite(siteId);
        if (!site || !site.user_id) throw new Error('Site/User not found for refresh wait');

        while (Date.now() - start < timeoutMs) {
            const res = await pool.query(`SELECT access_token, refresh_token, is_refreshing FROM "User" WHERE id = $1`, [site.user_id]);
            const row = res.rows[0];
            if (!row.is_refreshing) {
                return { access_token: row.access_token || '', refresh_token: row.refresh_token || '' };
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        throw new Error('Timeout waiting for token refresh lock');
    }

    getLockedRefreshHandler(siteId: string) {
        return {
            refreshHandler: async (refreshToken: string) => {
                console.log(`[TokenLock] Attempting to acquire lock for site ${siteId}...`);
                if (await this.acquireRefreshLock(siteId)) {
                    console.log(`[TokenLock] Lock acquired for site ${siteId}. Refreshing...`);
                    try {
                        const { refreshAccessToken } = await import('./tesla-auth');
                        const newTokens = await refreshAccessToken(refreshToken);

                        await this.updateSiteTokens(siteId, newTokens.access_token, newTokens.refresh_token);
                        return newTokens;
                    } finally {
                        await this.releaseRefreshLock(siteId);
                        console.log(`[TokenLock] Lock released for site ${siteId}.`);
                    }
                } else {
                    console.log(`[TokenLock] Lock busy for site ${siteId}. Waiting...`);
                    return this.waitForTokenRefresh(siteId);
                }
            },
            errorHandler: async (error: Error) => {
                const msg = error.message;
                if (msg.includes('401') || msg.includes('login_required') || msg.includes('invalid_grant')) {
                    const site = await this.siteRepo.getSite(siteId);
                    if (site && site.user_id) {
                        console.warn(`[TokenLock] Terminal auth failure for site ${siteId} (User ${site.user_id}). Marking revoked.`);
                        await pool.query('UPDATE "User" SET auth_status = $1, is_active = $2 WHERE id = $3', ['revoked', false, site.user_id]);
                        this.siteRepo.invalidateCache(siteId);
                    }
                }
            }
        };
    }
}
