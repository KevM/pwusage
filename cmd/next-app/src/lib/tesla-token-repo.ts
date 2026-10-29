import { logEvent, flushLogEvents } from './observability';
import { ioDelay, checkIoDeadline, withIoDeadline, ioFailureDetails } from './io-deadline';
import { pool } from './db';
import { SiteRepo } from './site-repo';
import { UserRepo } from './user-repo';
import { TeslaConnectionRequiredError, TeslaRefreshError } from './tesla-refresh-outcome';
import { createHash, randomUUID } from 'node:crypto';
import { parseRefreshedTokens, type RefreshedTokens } from './tesla-auth';
import { after } from 'next/server';

interface AccountCredentials {
    access_token: string | null;
    refresh_token: string | null;
    is_refreshing: number;
    auth_status: string | null;
    is_active: boolean;
    refresh_lock_expires: number;
    tesla_credential_generation: number;
    tesla_refresh_attempt_id: string;
    tesla_refresh_state: 'ready' | 'in_flight' | 'uncertain' | 'reconnect_required';
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
            const res = await pool.query<AccountCredentials>(`SELECT access_token, refresh_token, is_refreshing, auth_status, is_active, refresh_lock_expires, tesla_refresh_state, tesla_credential_generation, tesla_refresh_attempt_id FROM "User" WHERE id = $1`, [userId]);
            const row = res.rows[0];
            if (!row) {
                throw new Error('Token refresh wait failed: user not found');
            }
            if (row.tesla_refresh_state === 'in_flight' && Number(row.refresh_lock_expires) <= Date.now()) {
                const expired = await pool.query(`UPDATE "User" SET tesla_refresh_state = 'uncertain', auth_status = 'error', is_refreshing = 0
                    WHERE id = $1 AND tesla_refresh_state = 'in_flight' AND refresh_lock_expires <= $2`, [userId, Date.now()]);
                if (!expired.rowCount) continue;
                logEvent('warn', 'tesla.refresh.replay-suppressed', { ...fields, reason: 'expired-unresolved-attempt', exchangeId: row.tesla_refresh_attempt_id, generationId: credentialId(`${userId}:${row.tesla_credential_generation}`), fromState: 'in_flight', toState: 'uncertain' });
                throw new TeslaConnectionRequiredError();
            }
            if (row.is_active === false || row.auth_status === 'revoked'
                || row.tesla_refresh_state === 'uncertain' || row.tesla_refresh_state === 'reconnect_required') {
                logEvent('warn', 'tesla.refresh.replay-suppressed', { ...fields, exchangeId: row.tesla_refresh_attempt_id, generationId: credentialId(`${userId}:${row.tesla_credential_generation}`), currentState: row.tesla_refresh_state, reason: row.is_active === false ? 'account-ineligible' : 'unusable-generation' });
                throw new TeslaConnectionRequiredError();
            }
            if (!row.is_refreshing) {
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
        if (process.env.TESLA_REFRESH_PAUSED === '1') {
            logEvent('info', 'tesla.refresh.paused', { accountId: credentialId(userId), siteId });
            throw new TeslaRefreshError('not_dispatched', null, null, 'Tesla refresh is paused');
        }
        const now = Date.now();
        const lease = now + 60000;
        const exchangeId = randomUUID();
        const fields = { siteId, accountId: credentialId(userId) };
        // UPDATE RETURNING reads the credentials in the same atomic operation
        // that acquires the account lease. Never exchange a caller's stale copy.
        const claim = await pool.query<AccountCredentials>(`
            UPDATE "User"
            SET is_refreshing = 1, refresh_lock_expires = $1,
                tesla_refresh_state = 'in_flight', tesla_refresh_attempt_id = $4,
                tesla_refresh_started_at = NOW()
            WHERE id = $2 AND (is_refreshing = 0 OR refresh_lock_expires < $3)
              AND auth_status IS DISTINCT FROM 'revoked' AND is_active = true
              AND tesla_refresh_state = 'ready' AND tesla_refresh_retry_after <= $3
            RETURNING access_token, refresh_token, tesla_credential_generation, tesla_refresh_attempt_id
        `, [lease, userId, now, exchangeId]);
        if (!claim.rowCount) {
            logEvent('info', 'tesla.refresh.waiting', fields);
            return this.waitForUserRefresh(userId, 20000, siteId, Date.now(), suppliedRefresh);
        }

        // The caller may stop waiting, but a dispatched rotation must run through
        // persistence under its own deadline and the serverless request lifecycle.
        const operation = this.refreshClaimedUser(userId, suppliedRefresh, siteId, lease, claim.rows[0], fields, exchangeId);
        try {
            after(async () => { await operation.catch(() => undefined); });
        } catch {
            // Outside a request lifecycle (e.g. CLI), the caller owns the work.
        }
        return operation;
    }

    private async refreshClaimedUser(
        userId: string, suppliedRefresh: string, siteId: string | undefined,
        lease: number, current: AccountCredentials, fields: { siteId: string | undefined; accountId: string }, exchangeId: string,
    ): Promise<RefreshedTokens> {
        const generation = current.tesla_credential_generation;
        let unused = false;
        const exchangeFields = { ...fields, exchangeId, generationId: credentialId(`${userId}:${generation}`) };
        const startedAt = Date.now();
        let stage: 'exchange' | 'persistence' = 'exchange';
        let previousRefresh: string | undefined;
        try {
            if (!current?.refresh_token) throw new TeslaRefreshError('credential_rejected');
            previousRefresh = current.refresh_token;
            if (previousRefresh !== suppliedRefresh && current.access_token) {
                unused = true;
                logEvent('info', 'tesla.refresh.reused', {
                    ...exchangeFields, previousCredentialId: credentialId(suppliedRefresh), credentialId: credentialId(previousRefresh),
                });
                return parseRefreshedTokens(current);
            }
            logEvent('info', 'tesla.refresh.started', { ...exchangeFields, fromState: 'ready', toState: 'in_flight', persisted: true, leaseExpiresAt: new Date(lease).toISOString() });
            flushLogEvents();
            const { refreshAccessToken } = await import('./tesla-auth');
            const next = await withIoDeadline(18000, () => refreshAccessToken(previousRefresh!, exchangeFields), null);
            stage = 'persistence';
            logEvent('info', 'tesla.refresh.persistence-started', {
                ...exchangeFields, credentialId: credentialId(next.refresh_token),
            });
            // Once Tesla has rotated the grant, saving it must survive the
            // caller's cancellation, just like releasing the lease does.
            const saved = await withIoDeadline(1000, () => pool.query(`
                UPDATE "User" SET access_token = $1, refresh_token = $2,
                    tesla_credential_generation = tesla_credential_generation + 1,
                    tesla_refresh_state = 'ready', tesla_refresh_attempt_id = NULL,
                    auth_status = 'active', tesla_refresh_retry_after = 0
                WHERE id = $3 AND refresh_token = $4 AND refresh_lock_expires = $5
                  AND is_refreshing = 1 AND refresh_lock_expires > $6
                  AND auth_status IS DISTINCT FROM 'revoked' AND is_active = true
                  AND tesla_credential_generation = $7 AND tesla_refresh_attempt_id = $8
                  AND tesla_refresh_state = 'in_flight'
            `, [next.access_token, next.refresh_token, userId, previousRefresh, lease, Date.now(), generation, exchangeId]), null);
            if (!saved.rowCount) {
                logEvent('info', 'tesla.refresh.superseded', exchangeFields);
                // Our finally block releases only our lease, then the waiter
                // observes the winning login/worker's credentials.
            } else {
                if (siteId) this.siteRepo.invalidateCache(siteId);
                logEvent('info', 'tesla.refresh.succeeded', {
                    ...exchangeFields, previousCredentialId: credentialId(previousRefresh), credentialId: credentialId(next.refresh_token),
                    fromState: 'in_flight', toState: 'ready', persisted: true, outcome: 'credentials_received',
                    durationMs: Date.now() - startedAt, nextGenerationId: credentialId(`${userId}:${generation + 1}`),
                });
                return next;
            }
        } catch (error) {
            const outcome = stage === 'exchange' && error instanceof TeslaRefreshError ? error.outcome : 'outcome_unknown';
            const terminal = outcome === 'credential_rejected';
            const state = terminal ? 'reconnect_required'
                : outcome === 'not_dispatched' || outcome === 'configuration_rejected' ? 'ready' : 'uncertain';
            logEvent('warn', 'tesla.refresh.failed', {
                ...exchangeFields, stage, ...ioFailureDetails(error, undefined, false), terminal, outcome, durationMs: Date.now() - startedAt,
                status: error instanceof TeslaRefreshError ? error.status : null,
                errorCode: error instanceof TeslaRefreshError ? error.errorCode : null,
            });
            try {
                const recorded = await withIoDeadline(1000, () => pool.query(`
                    UPDATE "User" SET is_refreshing = 0, refresh_lock_expires = 0,
                        tesla_refresh_state = $5, tesla_refresh_retry_after = $6,
                        auth_status = CASE WHEN $5 = 'reconnect_required' THEN 'revoked' ELSE 'error' END
                    WHERE id = $1 AND tesla_credential_generation = $2 AND refresh_lock_expires = $3
                      AND tesla_refresh_attempt_id = $4 AND tesla_refresh_state = 'in_flight'
                `, [userId, generation, lease, exchangeId, state, state === 'ready' ? Date.now() + 900000 : 0]), null);
                if (!recorded.rowCount) logEvent('info', 'tesla.refresh.outcome-superseded', { ...exchangeFields, outcome, attemptedState: state });
                if (!recorded.rowCount && terminal) {
                    // A login may have superseded this rejected generation.
                    return await withIoDeadline(1000, () => this.waitForUserRefresh(userId, 1000, siteId, Date.now(), suppliedRefresh), null);
                }
                if (recorded.rowCount) logEvent('warn', 'tesla.refresh.state-changed', { ...exchangeFields, fromState: 'in_flight', toState: state, persisted: true, outcome, durationMs: Date.now() - startedAt });
                flushLogEvents();
            } catch {
                // The pre-dispatch marker is authoritative if this write fails.
                logEvent('warn', 'tesla.refresh.outcome-write-deferred', exchangeFields);
            }
            throw error;

        } finally {
            try {
                await withIoDeadline(1000, () => pool.query(`
                    UPDATE "User" SET is_refreshing = 0, refresh_lock_expires = 0,
                        tesla_refresh_state = CASE WHEN $4 THEN 'ready'
                            WHEN tesla_refresh_state = 'in_flight' THEN 'uncertain' ELSE tesla_refresh_state END
                    WHERE id = $1 AND refresh_lock_expires = $2
                      AND (tesla_refresh_attempt_id = $3 OR tesla_refresh_attempt_id IS NULL)
                `, [userId, lease, exchangeId, unused]), null);
            } catch {
                logEvent('warn', 'tesla.refresh.cleanup-deferred', exchangeFields);
            }
        }
        return this.waitForUserRefresh(userId, 20000, siteId, Date.now(), suppliedRefresh);
    }
}
