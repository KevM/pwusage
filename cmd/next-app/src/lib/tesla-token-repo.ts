import { logEvent } from './observability';
import { ioDelay, checkIoDeadline, withIoDeadline } from './io-deadline';
import { pool } from './db';
import { SiteRepo } from './site-repo';
import { UserRepo } from './user-repo';
import { isTeslaAuthError, TeslaAuthError } from './tesla-client';

export class TeslaTokenRepo {
    constructor(private siteRepo: SiteRepo, private userRepo: UserRepo = new UserRepo()) {}

    // === Queries ===
    async waitForTokenRefresh(siteId: string, timeoutMs = 20000): Promise<{ access_token: string; refresh_token: string }> {
        const start = Date.now();
        const site = await this.siteRepo.getSite(siteId);
        if (!site || !site.user_id) throw new Error('Site/User not found for refresh wait');

        while (Date.now() - start < timeoutMs) {
            const res = await pool.query(`SELECT access_token, refresh_token, is_refreshing, auth_status FROM "User" WHERE id = $1`, [site.user_id]);
            const row = res.rows[0];
            if (!row) {
                throw new Error('Token refresh wait failed: user not found');
            }
            if (!row.is_refreshing) {
                if (row.auth_status === 'revoked') {
                    logEvent('warn', 'tesla.refresh.wait-revoked', {
                        siteId, authStatus: row.auth_status, waitedMs: Date.now() - start,
                    });
                    // Preserve the terminal classification across the lock boundary.
                    // A plain Error here let account verification reactivate the user.
                    throw new TeslaAuthError('Token refresh failed: auth revoked');
                }
                logEvent('info', 'tesla.refresh.wait-completed', {
                    siteId, authStatus: row.auth_status, waitedMs: Date.now() - start,
                });
                return { access_token: row.access_token || '', refresh_token: row.refresh_token || '' };
            }
            await ioDelay(1000);
        }
        logEvent('warn', 'tesla.refresh.wait-timeout', { siteId, waitedMs: Date.now() - start });
        throw new Error('Timeout waiting for token refresh lock');
    }

    // === Commands ===
    async acquireRefreshLock(siteId: string): Promise<boolean> {
        const now = Date.now();
        const expires = now + 60000;

        const site = await this.siteRepo.getSite(siteId);
        if (site && site.user_id) {
            // A revoked user's refresh token is dead. Refusing the lock sends the
            // caller to waitForTokenRefresh, which throws on revoked, instead of
            // re-submitting the token that a concurrent refresh just had rejected.
            const result = await pool.query(`
                UPDATE "User"
                SET is_refreshing = 1, refresh_lock_expires = $1
                WHERE id = $2 AND (is_refreshing = 0 OR refresh_lock_expires < $3)
                  AND auth_status IS DISTINCT FROM 'revoked'
            `, [expires, site.user_id, now]);
            return (result.rowCount ?? 0) > 0;
        }

        return false;
    }

    async updateSiteTokens(siteId: string, accessToken: string, refreshToken: string) {
        const site = await this.siteRepo.getSite(siteId);

        if (site && site.user_id) {
            await this.userRepo.updateTokens(site.user_id, accessToken, refreshToken);
            logEvent('info', 'tesla.credentials.updated', { siteId });
        } else {
            console.warn(`[TeslaTokenRepo] Cannot update tokens for site ${siteId} - No User Linked!`);
        }

        this.siteRepo.invalidateCache(siteId);
    }

    async releaseRefreshLock(siteId: string) {
        const site = await this.siteRepo.getSite(siteId);
        if (site && site.user_id) {
            await pool.query('UPDATE "User" SET is_refreshing = 0, refresh_lock_expires = 0 WHERE id = $1', [site.user_id]);
        }
    }

    // Utility
    private isTerminalAuthError(error: unknown): boolean {
        return isTeslaAuthError(error);
    }

    getLockedRefreshHandler(siteId: string) {
        return {
            refreshHandler: async (refreshToken: string) => {
                checkIoDeadline();
                console.log(`[TokenLock] Attempting to acquire lock for site ${siteId}...`);
                if (await this.acquireRefreshLock(siteId)) {
                    logEvent('info', 'tesla.refresh.started', { siteId });
                    let terminalFailure = false;
                    try {
                        const { refreshAccessToken } = await import('./tesla-auth');
                        const newTokens = await refreshAccessToken(refreshToken);

                        await this.updateSiteTokens(siteId, newTokens.access_token, newTokens.refresh_token);
                        logEvent('info', 'tesla.refresh.succeeded', { siteId });
                        return newTokens;
                    } catch (err) {
                        logEvent('warn', 'tesla.refresh.failed', { siteId, terminal: this.isTerminalAuthError(err), error: err });
                        if (this.isTerminalAuthError(err)) {
                            terminalFailure = true;
                        }
                        throw err;
                    } finally {
                        try {
                            // The refresh deadline may already be aborted. Cleanup
                            // gets an independent short budget; expiry is the fallback.
                            await withIoDeadline(1000, async () => {
                                if (terminalFailure) {
                                    // Atomically mark revoked AND release the lock in one write so
                                    // waiters polling after is_refreshing drops to 0 always see the
                                    // revoked status — prevents the race window described in the P2 bug.
                                    const site = await this.siteRepo.getSite(siteId);
                                    if (site && site.user_id) {
                                        console.warn(`[TokenLock] Terminal auth failure for site ${siteId} (User ${site.user_id}). Revoking and releasing lock atomically.`);
                                        await pool.query(
                                            'UPDATE "User" SET is_refreshing = 0, refresh_lock_expires = 0, auth_status = $1, is_active = $2 WHERE id = $3',
                                            ['revoked', false, site.user_id]
                                        );
                                        this.siteRepo.invalidateCache(siteId);
                                        logEvent('warn', 'tesla.auth.revoked', { siteId, reason: 'terminal-refresh-failure' });
                                    }
                                } else {
                                    await this.releaseRefreshLock(siteId);
                                }
                                console.log(`[TokenLock] Lock released for site ${siteId}.`);
                            }, null);
                        } catch {
                            console.warn(`[TokenLock] Cleanup deferred for site ${siteId}; lock will expire.`);
                        }
                    }
                } else {
                    logEvent('info', 'tesla.refresh.waiting', { siteId });
                    return this.waitForTokenRefresh(siteId);
                }
            },
            errorHandler: async (error: Error) => {
                // Secondary guard: fires after refreshHandler has already released the lock.
                // For terminal failures the revoke was already written atomically above, so
                // this is a no-op in that path. Still useful for non-locked callers.
                if (this.isTerminalAuthError(error)) {
                    const site = await this.siteRepo.getSite(siteId);
                    if (site && site.user_id) {
                        console.warn(`[TokenLock] Secondary revoke guard for site ${siteId} (User ${site.user_id}).`);
                        await this.userRepo.updateUserStatus(site.user_id, 'revoked', false);
                        logEvent('warn', 'tesla.auth.revoked', { siteId, reason: 'secondary-auth-guard' });
                        this.siteRepo.invalidateCache(siteId);
                    }
                }
            }
        };
    }
}
