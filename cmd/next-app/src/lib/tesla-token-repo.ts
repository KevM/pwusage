import { logEvent } from './observability';
import { ioDelay, checkIoDeadline, withIoDeadline } from './io-deadline';
import { pool } from './db';
import { SiteRepo } from './site-repo';
import { UserRepo } from './user-repo';
import { isTeslaAuthError, TeslaAuthError } from './tesla-client';
import { createHash } from 'node:crypto';
import { parseRefreshedTokens, type RefreshedTokens } from './tesla-auth';

interface AccountCredentials {
    access_token: string | null;
    refresh_token: string | null;
    is_refreshing: number;
    auth_status: string | null;
}

function credentialId(value: string): string {
    return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

export class TeslaTokenRepo {
    constructor(private siteRepo: SiteRepo, private userRepo: UserRepo = new UserRepo()) {}

    // === Queries ===
    async waitForTokenRefresh(siteId: string, timeoutMs = 20000): Promise<{ access_token: string; refresh_token: string }> {
        const start = Date.now();
        const site = await this.siteRepo.getSite(siteId);
        if (!site || !site.user_id) throw new Error('Site/User not found for refresh wait');

        return this.waitForUserRefresh(site.user_id, timeoutMs, siteId, start);
    }

    private async waitForUserRefresh(userId: string, timeoutMs = 20000, siteId?: string, start = Date.now(), suppliedRefresh?: string): Promise<RefreshedTokens> {
        const fields = { siteId, accountId: credentialId(userId) };
        while (Date.now() - start < timeoutMs) {
            const res = await pool.query<AccountCredentials>(`SELECT access_token, refresh_token, is_refreshing, auth_status FROM "User" WHERE id = $1`, [userId]);
            const row = res.rows[0];
            if (!row) {
                throw new Error('Token refresh wait failed: user not found');
            }
            if (!row.is_refreshing) {
                if (row.auth_status === 'revoked') {
                    logEvent('warn', 'tesla.refresh.wait-revoked', {
                        ...fields, authStatus: row.auth_status, waitedMs: Date.now() - start,
                    });
                    // Preserve the terminal classification across the lock boundary.
                    // A plain Error here let account verification reactivate the user.
                    throw new TeslaAuthError('Token refresh failed: auth revoked');
                }
                const current = parseRefreshedTokens(row);
                if (suppliedRefresh === current.refresh_token) {
                    // A transient failure released the lease without rotating.
                    // Returning the expired access credential would turn the
                    // waiter's retry into a misleading terminal Fleet 401.
                    throw new Error('Concurrent credential renewal did not update stored credentials');
                }
                logEvent('info', 'tesla.refresh.wait-completed', {
                    ...fields, authStatus: row.auth_status, waitedMs: Date.now() - start,
                    credentialId: credentialId(current.refresh_token),
                });
                return current;
            }
            await ioDelay(1000);
        }
        logEvent('warn', 'tesla.refresh.wait-timeout', { ...fields, waitedMs: Date.now() - start });
        throw new Error('Timeout waiting for token refresh lock');
    }

    // === Commands ===
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

    getLockedRefreshHandler(siteId: string) {
        return {
            refreshHandler: async (refreshToken: string) => {
                const site = await this.siteRepo.getSite(siteId);
                if (!site?.user_id) throw new Error('Site/User not found for refresh');
                return this.refreshUser(site.user_id, refreshToken, siteId);
            },
            // Revocation belongs inside refreshUser's guarded write. A callback
            // after releasing the lease could revoke a subsequent successful login.
            errorHandler: async () => {},
        };
    }

    getLockedUserRefreshHandler(userId: string) {
        return {
            refreshHandler: (refreshToken: string) => this.refreshUser(userId, refreshToken),
            errorHandler: async () => {},
        };
    }

    private async refreshUser(userId: string, suppliedRefresh: string, siteId?: string): Promise<RefreshedTokens> {
        checkIoDeadline();
        const now = Date.now();
        const lease = now + 60000;
        const fields = { siteId, accountId: credentialId(userId) };
        // UPDATE RETURNING reads the credentials in the same atomic operation
        // that acquires the account lease. Never exchange a caller's stale copy.
        const claim = await pool.query<AccountCredentials>(`
            UPDATE "User"
            SET is_refreshing = 1, refresh_lock_expires = $1
            WHERE id = $2 AND (is_refreshing = 0 OR refresh_lock_expires < $3)
              AND auth_status IS DISTINCT FROM 'revoked'
            RETURNING access_token, refresh_token
        `, [lease, userId, now]);
        if (!claim.rowCount) {
            logEvent('info', 'tesla.refresh.waiting', fields);
            return this.waitForUserRefresh(userId, 20000, siteId, Date.now(), suppliedRefresh);
        }

        let previousRefresh: string | undefined;
        try {
            const current = claim.rows[0];
            if (!current?.refresh_token) throw new Error('Stored Tesla credentials do not include a renewal grant');
            previousRefresh = current.refresh_token;
            if (previousRefresh !== suppliedRefresh && current.access_token) {
                logEvent('info', 'tesla.refresh.reused', {
                    ...fields, previousCredentialId: credentialId(suppliedRefresh), credentialId: credentialId(previousRefresh),
                });
                return parseRefreshedTokens(current);
            }
            logEvent('info', 'tesla.refresh.started', { ...fields, credentialId: credentialId(previousRefresh) });
            const { refreshAccessToken } = await import('./tesla-auth');
            const next = await refreshAccessToken(previousRefresh);
            // Once Tesla has rotated the grant, saving it must survive the
            // caller's cancellation, just like releasing the lease does.
            const saved = await withIoDeadline(1000, () => pool.query(`
                UPDATE "User" SET access_token = $1, refresh_token = $2
                WHERE id = $3 AND refresh_token = $4 AND refresh_lock_expires = $5
                  AND is_refreshing = 1 AND refresh_lock_expires > $6
                  AND auth_status IS DISTINCT FROM 'revoked'
            `, [next.access_token, next.refresh_token, userId, previousRefresh, lease, Date.now()]), null);
            if (!saved.rowCount) {
                logEvent('info', 'tesla.refresh.superseded', fields);
                // Our finally block releases only our lease, then the waiter
                // observes the winning login/worker's credentials.
            } else {
                if (siteId) this.siteRepo.invalidateCache(siteId);
                logEvent('info', 'tesla.refresh.succeeded', {
                    ...fields, previousCredentialId: credentialId(previousRefresh), credentialId: credentialId(next.refresh_token),
                });
                return next;
            }
        } catch (error) {
            const terminal = isTeslaAuthError(error);
            logEvent('warn', 'tesla.refresh.failed', {
                ...fields, terminal, error, credentialId: previousRefresh ? credentialId(previousRefresh) : undefined,
            });
            if (!terminal || !previousRefresh) throw error;
            // Cleanup has its own budget so a parent cancellation does not skip
            // terminal revocation. Compare credentials as well as lease ownership:
            // a successful login may replace them without acquiring this lease.
            const revoked = await withIoDeadline(1000, () => pool.query(`
                UPDATE "User" SET is_refreshing = 0, refresh_lock_expires = 0,
                    auth_status = 'revoked', is_active = false
                WHERE id = $1 AND refresh_token = $2 AND refresh_lock_expires = $3
                  AND is_refreshing = 1 AND refresh_lock_expires > $4
            `, [userId, previousRefresh, lease, Date.now()]), null);
            if (revoked.rowCount) {
                if (siteId) this.siteRepo.invalidateCache(siteId);
                logEvent('warn', 'tesla.auth.revoked', { ...fields, reason: 'terminal-refresh-failure' });
                throw error;
            }
        } finally {
            try {
                await withIoDeadline(1000, () => pool.query(`
                    UPDATE "User" SET is_refreshing = 0, refresh_lock_expires = 0
                    WHERE id = $1 AND refresh_lock_expires = $2
                `, [userId, lease]), null);
            } catch {
                logEvent('warn', 'tesla.refresh.cleanup-deferred', fields);
            }
        }
        return this.waitForUserRefresh(userId, 20000, siteId, Date.now(), suppliedRefresh);
    }
}
