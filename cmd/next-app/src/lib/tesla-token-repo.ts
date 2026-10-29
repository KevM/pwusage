import { logEvent, flushLogEvents } from './observability';
import { ioDelay, checkIoDeadline, withIoDeadline, ioFailureDetails } from './io-deadline';
import { pool } from './db';
import { SiteRepo } from './site-repo';
import { UserRepo } from './user-repo';
import { TeslaConnectionRequiredError, TeslaRefreshBackoffError, TeslaRefreshError } from './tesla-refresh-outcome';
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
    tesla_refresh_retry_after: number | string;
}

const LEASE_MS = 60_000;
// Long enough for a slow worker to finish its 18s exchange and save before the
// grant can be claimed again; short enough that a 429/5xx blip is not an outage.
const TRANSIENT_BACKOFF_MS = 2 * 60_000;
const CONFIGURATION_BACKOFF_MS = 15 * 60_000;
const SAVE_ATTEMPTS = 2;
const SAVE_DEADLINE_MS = 5000;

function credentialId(value: string): string {
    return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

export class TeslaTokenRepo {
    constructor(private siteRepo: SiteRepo, private userRepo: UserRepo = new UserRepo()) {}

    // === Queries ===
    private async waitForUserRefresh(userId: string, suppliedRefresh: string, siteId?: string, timeoutMs = 20000, start = Date.now()): Promise<RefreshedTokens> {
        const fields = { siteId, accountId: credentialId(userId) };
        while (Date.now() - start < timeoutMs) {
            const res = await pool.query<AccountCredentials>(`SELECT access_token, refresh_token, is_refreshing, auth_status, is_active, refresh_lock_expires, tesla_refresh_state, tesla_refresh_retry_after, tesla_credential_generation, tesla_refresh_attempt_id FROM "User" WHERE id = $1`, [userId]);
            const row = res.rows[0];
            if (!row) {
                throw new Error('Token refresh wait failed: user not found');
            }
            if (row.tesla_refresh_state === 'in_flight' && Number(row.refresh_lock_expires) <= Date.now()) {
                // The worker died mid-exchange. Its grant is retried after a
                // backoff: if Tesla consumed it, the replacement was never
                // stored, so a retry cannot lose anything we hold. The attempt
                // id stays so a worker that is merely slow can still save.
                const now = Date.now();
                const expired = await pool.query(`UPDATE "User" SET is_refreshing = 0, refresh_lock_expires = 0,
                        tesla_refresh_state = 'ready', tesla_refresh_retry_after = $3, auth_status = 'error'
                    WHERE id = $1 AND tesla_refresh_state = 'in_flight' AND refresh_lock_expires <= $2`, [userId, now, now + TRANSIENT_BACKOFF_MS]);
                if (expired.rowCount) logEvent('warn', 'tesla.refresh.lease-expired', { ...fields, exchangeId: row.tesla_refresh_attempt_id, generationId: credentialId(`${userId}:${row.tesla_credential_generation}`), fromState: 'in_flight', toState: 'ready', retryAfter: new Date(now + TRANSIENT_BACKOFF_MS).toISOString() });
                continue;
            }
            if (row.is_active === false || row.auth_status === 'revoked'
                || row.tesla_refresh_state === 'uncertain' || row.tesla_refresh_state === 'reconnect_required') {
                logEvent('warn', 'tesla.refresh.replay-suppressed', { ...fields, exchangeId: row.tesla_refresh_attempt_id, generationId: credentialId(`${userId}:${row.tesla_credential_generation}`), currentState: row.tesla_refresh_state, reason: row.is_active === false ? 'account-ineligible' : 'unusable-generation' });
                throw new TeslaConnectionRequiredError();
            }
            if (!row.is_refreshing || row.tesla_refresh_state !== 'in_flight') {
                if (row.refresh_token && row.refresh_token !== suppliedRefresh) {
                    const current = parseRefreshedTokens(row);
                    logEvent('info', 'tesla.refresh.wait-completed', {
                        ...fields, authStatus: row.auth_status, waitedMs: Date.now() - start,
                        previousCredentialId: credentialId(suppliedRefresh), credentialId: credentialId(current.refresh_token),
                    });
                    return current;
                }
                const retryAfter = Number(row.tesla_refresh_retry_after ?? 0);
                if (retryAfter > Date.now()) {
                    logEvent('info', 'tesla.refresh.backoff', { ...fields, retryAfter: new Date(retryAfter).toISOString() });
                    throw new TeslaRefreshBackoffError(retryAfter);
                }
                // A transient failure released the lease without rotating.
                // Returning the expired access credential would turn the
                // waiter's retry into a misleading terminal Fleet 401.
                throw new Error('Concurrent credential renewal did not update stored credentials');
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
        const lease = now + LEASE_MS;
        const exchangeId = randomUUID();
        const fields = { siteId, accountId: credentialId(userId) };
        // Claim only the grant the caller holds. A stale caller (another worker
        // already rotated) must never mark the account in flight: it adopts the
        // stored rotation from the wait below instead.
        const claim = await pool.query<AccountCredentials>(`
            UPDATE "User"
            SET is_refreshing = 1, refresh_lock_expires = $1,
                tesla_refresh_state = 'in_flight', tesla_refresh_attempt_id = $4,
                tesla_refresh_started_at = NOW()
            WHERE id = $2 AND (is_refreshing = 0 OR refresh_lock_expires < $3)
              AND auth_status IS DISTINCT FROM 'revoked' AND is_active = true
              AND tesla_refresh_state = 'ready' AND tesla_refresh_retry_after <= $3
              AND refresh_token = $5
            RETURNING access_token, refresh_token, tesla_credential_generation, tesla_refresh_attempt_id
        `, [lease, userId, now, exchangeId, suppliedRefresh]);
        if (!claim.rowCount) {
            logEvent('info', 'tesla.refresh.not-claimed', fields);
            return this.waitForUserRefresh(userId, suppliedRefresh, siteId);
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

    /**
     * Save a rotated pair. Tesla has already consumed the old grant, so this is
     * guarded only by what proves no newer credential write happened (generation,
     * attempt id, old grant), not by the lease clock: a slow save must still land.
     */
    private async saveRotation(userId: string, next: RefreshedTokens, previousRefresh: string, generation: number, exchangeId: string): Promise<boolean> {
        const save = () => pool.query(`
            UPDATE "User" SET access_token = $1, refresh_token = $2,
                tesla_credential_generation = tesla_credential_generation + 1,
                tesla_refresh_state = 'ready', tesla_refresh_attempt_id = NULL,
                auth_status = 'active', tesla_refresh_retry_after = 0,
                is_refreshing = 0, refresh_lock_expires = 0
            WHERE id = $3 AND refresh_token = $4
              AND tesla_credential_generation = $5 AND tesla_refresh_attempt_id = $6
        `, [next.access_token, next.refresh_token, userId, previousRefresh, generation, exchangeId]);
        let lastError: unknown;
        for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt++) {
            try {
                // Once Tesla has rotated the grant, saving it must survive the
                // caller's cancellation, just like releasing the lease does.
                return Boolean((await withIoDeadline(SAVE_DEADLINE_MS, save, null)).rowCount);
            } catch (error) {
                // A lost acknowledgement may have committed; the guard makes
                // the retry a no-op then, and the waiter reads the saved pair.
                lastError = error;
            }
        }
        throw lastError;
    }

    private async refreshClaimedUser(
        userId: string, suppliedRefresh: string, siteId: string | undefined,
        lease: number, current: AccountCredentials, fields: { siteId: string | undefined; accountId: string }, exchangeId: string,
    ): Promise<RefreshedTokens> {
        const generation = current.tesla_credential_generation;
        const exchangeFields = { ...fields, exchangeId, generationId: credentialId(`${userId}:${generation}`) };
        const startedAt = Date.now();
        let stage: 'exchange' | 'persistence' = 'exchange';
        try {
            const previousRefresh = current.refresh_token;
            if (!previousRefresh) throw new TeslaRefreshError('credential_rejected');
            logEvent('info', 'tesla.refresh.started', { ...exchangeFields, fromState: 'ready', toState: 'in_flight', persisted: true, leaseExpiresAt: new Date(lease).toISOString() });
            flushLogEvents();
            const { refreshAccessToken } = await import('./tesla-auth');
            const next = await withIoDeadline(18000, () => refreshAccessToken(previousRefresh, exchangeFields), null);
            stage = 'persistence';
            logEvent('info', 'tesla.refresh.persistence-started', {
                ...exchangeFields, credentialId: credentialId(next.refresh_token),
            });
            if (await this.saveRotation(userId, next, previousRefresh, generation, exchangeId)) {
                if (siteId) this.siteRepo.invalidateCache(siteId);
                logEvent('info', 'tesla.refresh.succeeded', {
                    ...exchangeFields, previousCredentialId: credentialId(previousRefresh), credentialId: credentialId(next.refresh_token),
                    fromState: 'in_flight', toState: 'ready', persisted: true, outcome: 'credentials_received',
                    durationMs: Date.now() - startedAt, nextGenerationId: credentialId(`${userId}:${generation + 1}`),
                });
                return next;
            }
            // A login or a lost-but-committed save superseded this attempt; the
            // waiter below observes the winning credentials.
            logEvent('info', 'tesla.refresh.superseded', exchangeFields);
        } catch (error) {
            const outcome = stage === 'exchange' && error instanceof TeslaRefreshError ? error.outcome : 'outcome_unknown';
            const terminal = outcome === 'credential_rejected';
            // Only Tesla rejecting the grant needs a reconnect. Everything else
            // (429, 5xx, transport loss, our own config) retries the same grant
            // after a backoff.
            const state = terminal ? 'reconnect_required' : 'ready';
            const retryAfter = terminal ? 0 : Date.now()
                + (outcome === 'not_dispatched' || outcome === 'configuration_rejected' ? CONFIGURATION_BACKOFF_MS : TRANSIENT_BACKOFF_MS);
            logEvent('warn', 'tesla.refresh.failed', {
                ...exchangeFields, stage, ...ioFailureDetails(error, undefined, false), terminal, outcome, durationMs: Date.now() - startedAt,
                status: error instanceof TeslaRefreshError ? error.status : null,
                errorCode: error instanceof TeslaRefreshError ? error.errorCode : null,
            });
            try {
                // Guarded by attempt id, not the lease: a late outcome from a
                // worker whose lease expired is still this grant's outcome.
                const recorded = await withIoDeadline(SAVE_DEADLINE_MS, () => pool.query(`
                    UPDATE "User" SET is_refreshing = 0, refresh_lock_expires = 0,
                        tesla_refresh_state = $4, tesla_refresh_retry_after = $5,
                        auth_status = CASE WHEN $4 = 'reconnect_required' THEN 'revoked' ELSE 'error' END
                    WHERE id = $1 AND tesla_credential_generation = $2 AND tesla_refresh_attempt_id = $3
                `, [userId, generation, exchangeId, state, retryAfter]), null);
                if (!recorded.rowCount) logEvent('info', 'tesla.refresh.outcome-superseded', { ...exchangeFields, outcome, attemptedState: state });
                if (!recorded.rowCount && terminal) {
                    // A login may have superseded this rejected generation.
                    return await withIoDeadline(1000, () => this.waitForUserRefresh(userId, suppliedRefresh, siteId, 1000), null);
                }
                if (recorded.rowCount) logEvent('warn', 'tesla.refresh.state-changed', { ...exchangeFields, fromState: 'in_flight', toState: state, persisted: true, outcome, durationMs: Date.now() - startedAt, ...(retryAfter ? { retryAfter: new Date(retryAfter).toISOString() } : {}) });
                flushLogEvents();
            } catch {
                // The lease expires into a backoff if this write fails.
                logEvent('warn', 'tesla.refresh.outcome-write-deferred', exchangeFields);
            }
            throw error;

        } finally {
            try {
                // Release a lease nothing else resolved (superseded, or the
                // outcome write failed) into a backoff, never leave it in flight.
                await withIoDeadline(1000, () => pool.query(`
                    UPDATE "User" SET is_refreshing = 0, refresh_lock_expires = 0,
                        tesla_refresh_retry_after = CASE WHEN tesla_refresh_state = 'in_flight' THEN $4 ELSE tesla_refresh_retry_after END,
                        tesla_refresh_state = CASE WHEN tesla_refresh_state = 'in_flight' THEN 'ready' ELSE tesla_refresh_state END
                    WHERE id = $1 AND refresh_lock_expires = $2 AND tesla_refresh_attempt_id = $3
                `, [userId, lease, exchangeId, Date.now() + TRANSIENT_BACKOFF_MS]), null);
            } catch {
                logEvent('warn', 'tesla.refresh.cleanup-deferred', exchangeFields);
            }
        }
        return this.waitForUserRefresh(userId, suppliedRefresh, siteId);
    }
}
