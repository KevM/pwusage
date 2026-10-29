import { type TeslaConnectionState, isRefreshLeaseActive, requiresTeslaReconnect } from './tesla-refresh-outcome';
import { cache } from 'react';
import { createHash, randomUUID } from 'node:crypto';
import { flushLogEvents, logEvent } from './observability';
import { pool, User, Site } from './db';
import { TeslaClient, isTeslaAuthError } from './tesla-client';
import { latestStoredSampleSql } from './latest-stored-sample-sql';
import { normalizeFleetBaseUrl } from './tesla-region';

export interface UserWithSites extends User {
    sites: Site[];
    has_trmnl_integration?: boolean;
}

export interface UserAuthState {
    isActive: boolean;
    sessionVersion: number;
    roles: string[];
}

interface VerificationState extends TeslaConnectionState {
    auth_version: string;
    auth_status: string | null;
    is_active: boolean | null;
}

export class UserRepo {
    // === Queries ===
    async getByAccessToken(token: string): Promise<{ id: string, email?: string, roles?: string[] } | null> {
        const res = await pool.query('SELECT id, email, roles FROM "User" WHERE access_token = $1', [token]);
        if (res.rows.length === 0) return null;
        return res.rows[0];
    }

    async getTokens(userId: string): Promise<{ access_token: string, refresh_token: string, fleet_api_base_url: string | null } & TeslaConnectionState | null> {
        const res = await pool.query('SELECT access_token, refresh_token, fleet_api_base_url, is_active, auth_status, tesla_refresh_state, refresh_lock_expires, tesla_refresh_retry_after FROM "User" WHERE id = $1', [userId]);
        if (res.rows.length === 0) return null;
        return res.rows[0];
    }

    async getTokensForSite(siteId: string): Promise<{ access_token: string, refresh_token: string, user_id: string, fleet_api_base_url: string | null } & TeslaConnectionState | null> {
        const res = await pool.query(`
            SELECT u.access_token, u.refresh_token, u.id as user_id, u.fleet_api_base_url, u.is_active, u.auth_status, u.tesla_refresh_state, u.refresh_lock_expires, u.tesla_refresh_retry_after
            FROM "User" u
            JOIN "Site" s ON s.user_id = u.id
            WHERE s.id = $1
        `, [siteId]);
        if (res.rows.length === 0) return null;
        return res.rows[0];
    }

    async isActive(userId: string): Promise<boolean> {
        const res = await pool.query('SELECT is_active FROM "User" WHERE id = $1', [userId]);
        return res.rows.length > 0 && res.rows[0].is_active === true;
    }

    /**
     * Single-query auth state for per-request authorization. The DB is the
     * source of truth for active status, session_version (sign-out-everywhere),
     * and roles; the site_auth JWT is only a cache of these claims.
     */
    async getAuthState(userId: string): Promise<UserAuthState | null> {
        const res = await pool.query('SELECT is_active, session_version, roles FROM "User" WHERE id = $1', [userId]);
        if (res.rows.length === 0) return null;
        const row = res.rows[0];
        return {
            isActive: row.is_active === true,
            sessionVersion: row.session_version ?? 0,
            roles: row.roles || []
        };
    }

    async getById(userId: string): Promise<User | null> {
        const res = await pool.query('SELECT * FROM "User" WHERE id = $1', [userId]);
        if (res.rows.length === 0) return null;
        return res.rows[0] as User;
    }

    async getByEmail(email: string): Promise<User | null> {
        // idx_user_email_lower guarantees at most one row per email; the
        // ORDER BY id LIMIT 1 is retained only as defense-in-depth from the
        // pre-index era (duplicate rows were possible before the dedupe
        // migration).
        const res = await pool.query('SELECT * FROM "User" WHERE LOWER(email) = LOWER($1) ORDER BY id LIMIT 1', [email]);
        if (res.rows.length === 0) return null;
        return res.rows[0] as User;
    }

    async getAllUsers(options: { includeTokens?: boolean } = {}): Promise<UserWithSites[]> {
        const tokenCols = options.includeTokens ? ', u.access_token, u.refresh_token' : '';
        // Fetch users and check for Trmnl integration in a single query using subquery (efficiently handles the join logic)
        const userRes = await pool.query(`
            SELECT u.id, u.email, u.roles, u.is_active, u.auth_status, u.tesla_refresh_state, u.tesla_refresh_started_at, u.last_checked_at, u.auth_lost_at, u.auth_restored_at, u.created_at${tokenCols},
            EXISTS (
                SELECT 1
                FROM "TrmnlInstallation" ti
                JOIN "Site" s ON s.id = ti.site_id
                WHERE s.user_id = u.id
            ) as has_trmnl_integration,
            (
                SELECT MAX(${latestStoredSampleSql('s.id')}) FROM "Site" s WHERE s.user_id = u.id
            ) as last_data_import
            FROM "User" u
            ORDER BY last_data_import DESC NULLS LAST, u.is_active DESC
        `);
        const users = userRes.rows as (User & { has_trmnl_integration: boolean; last_data_import: string | null })[];

        // Fetch all sites (optimization: fetch all and map in memory instead of N+1 queries)
        // We also strip tokens from Site results here
        const siteRes = await pool.query('SELECT id, user_id, name, utility, updated, installed, timezone, billing_start_day, timezone_display_mode FROM "Site"');
        const sites = siteRes.rows as Site[];

        // Map sites to users
        const usersWithSites: UserWithSites[] = users.map(user => {
            const userSites = sites.filter(s => s.user_id === user.id);
            return {
                ...user,
                sites: userSites,
                has_trmnl_integration: user.has_trmnl_integration,
                last_data_import: user.last_data_import
            };
        });

        return usersWithSites;
    }

    async getUserEmail(userId: string): Promise<string | null> {
        const res = await pool.query('SELECT email FROM "User" WHERE id = $1', [userId]);
        return res.rows.length > 0 ? res.rows[0].email : null;
    }

    // === Commands ===
    /**
     * Invalidate every outstanding site_auth JWT for the user ("sign out
     * everywhere"). Tokens whose embedded sv trails the new value are blocked
     * on each authenticated request and refused refresh; re-authenticating
     * issues a token stamped with the new version.
     */
    async bumpSessionVersion(userId: string): Promise<void> {
        await pool.query('UPDATE "User" SET session_version = session_version + 1 WHERE id = $1', [userId]);
    }

    async updateUserEmail(userId: string, email: string): Promise<void> {
        await pool.query('UPDATE "User" SET email = $1 WHERE id = $2', [email, userId]);
    }

    async updateUserStatus(userId: string, authStatus: string, isActive: boolean) {
        await pool.query(
            'UPDATE "User" SET auth_status = $1, is_active = $2, last_checked_at = NOW() WHERE id = $3',
            [authStatus, isActive, userId]
        );
    }

    /**
     * When the site owner's Tesla access last came back after an outage
     * (`auth_restored_at`, stamped by the `stamp_user_auth_outage` trigger), or null.
     */
    async getAuthRestoredAtForSite(siteId: string): Promise<Date | null> {
        const { rows } = await pool.query<{ auth_restored_at: Date | null }>(
            'SELECT u.auth_restored_at FROM "Site" s JOIN "User" u ON u.id = s.user_id WHERE s.id = $1',
            [siteId]
        );
        return rows[0]?.auth_restored_at ?? null;
    }

    async updateLastChecked(userId: string) {
        await pool.query(
            'UPDATE "User" SET last_checked_at = NOW() WHERE id = $1',
            [userId]
        );
    }

    async upsertOnTeslaAuth(params: {
        userId: string;
        email: string | null;
        accessToken: string;
        refreshToken: string;
        tokenExpiresAt: number;
        /** The account's regional Fleet host; unknown keeps the stored one. */
        fleetApiBaseUrl?: string | null;
    }): Promise<void> {
        const saved = await pool.query<{ tesla_credential_generation: number; is_active: boolean }>(`
            INSERT INTO "User" (id, email, access_token, refresh_token, token_expires_at, auth_status, is_active, fleet_api_base_url)
            VALUES ($1, $2, $3, $4, $5, 'active', true, $6)
            ON CONFLICT (id) DO UPDATE SET
                access_token = EXCLUDED.access_token,
                refresh_token = EXCLUDED.refresh_token,
                email = COALESCE(EXCLUDED.email, "User".email),
                fleet_api_base_url = COALESCE(EXCLUDED.fleet_api_base_url, "User".fleet_api_base_url),
                auth_status = 'active',
                tesla_credential_generation = "User".tesla_credential_generation + 1,
                tesla_refresh_state = 'ready', tesla_refresh_attempt_id = NULL,
                tesla_refresh_retry_after = 0, is_refreshing = 0, refresh_lock_expires = 0
            RETURNING tesla_credential_generation, is_active
        `, [params.userId, params.email, params.accessToken, params.refreshToken, params.tokenExpiresAt,
            normalizeFleetBaseUrl(params.fleetApiBaseUrl)]);
        if (saved?.rows[0]) {
            logEvent('info', 'tesla.connection.credentials-restored', {
                accountId: createHash('sha256').update(params.userId).digest('hex').slice(0, 16),
                generationId: createHash('sha256').update(`${params.userId}:${saved.rows[0].tesla_credential_generation}`).digest('hex').slice(0, 16),
                toState: 'ready', persisted: true, source: 'oauth-login', accountEligible: saved.rows[0].is_active,
            });
            flushLogEvents();
        }
    }

    /** Record the account's regional Fleet host. Only allowlisted Tesla hosts are stored. */
    async setFleetApiBaseUrl(userId: string, baseUrl: string): Promise<void> {
        const normalized = normalizeFleetBaseUrl(baseUrl);
        if (!normalized) {
            console.warn('[UserRepo] Refusing to store unrecognized Fleet API host for user', userId);
            return;
        }
        await pool.query('UPDATE "User" SET fleet_api_base_url = $1 WHERE id = $2', [normalized, userId]);
    }

    async updateTokens(userId: string, accessToken: string, refreshToken: string): Promise<void> {
        await pool.query(
            'UPDATE "User" SET access_token = $1, refresh_token = $2 WHERE id = $3',
            [accessToken, refreshToken, userId]
        );
    }

    async verifyUserStatus(
        user: Pick<User, 'id' | 'auth_status' | 'is_active' | 'last_checked_at'> & { sites?: Pick<Site, 'id'>[] },
        deps?: { createClient?: (siteId: string) => Promise<Pick<TeslaClient, 'getLiveStatus'> | null> }
    ): Promise<{ status: string; error?: string }> {
        const started = Date.now();
        const verificationId = randomUUID();
        let siteId: string | undefined;
        let phase: 'auth-snapshot' | 'site-lookup' | 'client-construction' | 'live-status' | 'status-write' = 'auth-snapshot';
        // These are the batch-selection snapshot, not a fresh read of auth state.
        const snapshot = {
            accountId: createHash('sha256').update(user.id).digest('hex').slice(0, 16),
            siteIds: user.sites?.map(site => site.id),
            selectedAuthStatus: user.auth_status ?? null,
            selectedIsActive: user.is_active ?? null,
            selectedLastCheckedAt: user.last_checked_at
                ? new Date(user.last_checked_at).toISOString() : null,
        };
        logEvent('info', 'tesla.user-verification.started', { verificationId, ...snapshot });
        const finish = (outcome: string, reason: string, error?: unknown, errorMessage?: string) => {
            logEvent(outcome === 'revoked' || outcome === 'error' ? 'warn' : 'info',
                'tesla.user-verification.completed', {
                    verificationId, siteId, ...snapshot, outcome, reason,
                    durationMs: Date.now() - started, ...(error ? { error } : {}),
                });
            flushLogEvents();
            return { status: outcome, ...(errorMessage ? { error: errorMessage } : {}) };
        };
        try {
            // xmin identifies this row version, not just its current status.
            // A login, refresh, revocation, or session-version bump during the
            // network check must supersede every eventual verification write.
            // No transaction/row lock is held across a Tesla request.
            const initial = await pool.query<VerificationState>(
                'SELECT xmin::text AS auth_version, auth_status, is_active, tesla_refresh_state, refresh_lock_expires FROM "User" WHERE id = $1', [user.id],
            );
            const authVersion = initial.rows[0]?.auth_version;
            if (!initial.rows.length) return finish('missing', 'account-missing');
            if (!authVersion) throw new Error('Account verification snapshot did not include a row version');

            if (initial.rows[0].is_active === false) return finish('inactive', 'account-ineligible');
            if (requiresTeslaReconnect(initial.rows[0]) || isRefreshLeaseActive(initial.rows[0])) {
                return finish('reconnect_required', 'exchange-state-blocked');
            }

            const commitStatus = async (outcome: string, reason: string, error?: unknown, errorMessage?: string) => {
                phase = 'status-write';
                const updated = await pool.query(`
                    UPDATE "User" SET auth_status = $1, is_active = $2, last_checked_at = NOW()
                    WHERE id = $3 AND xmin::text = $4
                      AND ($5::text IS NULL OR EXISTS (
                          SELECT 1 FROM "Site" WHERE id = $5 AND user_id = $3
                      ))
                      AND ($1 <> 'no_sites' OR NOT EXISTS (
                          SELECT 1 FROM "Site" WHERE user_id = $3
                      ))
                `, [outcome, initial.rows[0].is_active, user.id, authVersion, siteId ?? null]);
                if (updated.rowCount) return finish(outcome, reason, error, errorMessage);

                const current = await pool.query<Pick<VerificationState, 'auth_status' | 'is_active'>>(
                    'SELECT auth_status, is_active FROM "User" WHERE id = $1', [user.id],
                );
                const latest = current.rows[0];
                logEvent('info', 'tesla.user-verification.superseded', {
                    verificationId, siteId, accountId: snapshot.accountId, attemptedOutcome: outcome,
                    currentAuthStatus: latest?.auth_status ?? null,
                    currentIsActive: latest?.is_active ?? null,
                });
                // Report the retained state, without returning an obsolete
                // error alongside a successful newer login. The skipped write
                // deliberately leaves last_checked_at unchanged for a retry.
                const retainedStatus = !latest ? 'missing'
                    : latest.auth_status === 'active' && latest.is_active !== true ? 'inactive'
                    : latest.auth_status ?? (latest.is_active === true ? 'active' : 'inactive');
                return finish(retainedStatus, 'auth-state-changed');
            };

            // Get user's sites to test with
            phase = 'site-lookup';
            const sitesRes = await pool.query('SELECT id FROM "Site" WHERE user_id = $1 LIMIT 1', [user.id]);
            if (sitesRes.rows.length === 0) {
                // No sites - can't verify credentials
                return await commitStatus('no_sites', 'no-linked-site');
            }
            siteId = sitesRes.rows[0].id as string;
            logEvent('info', 'tesla.user-verification.checking', { verificationId, siteId, ...snapshot });
            flushLogEvents();

            // Build the client through the site factory: it re-reads tokens fresh
            // from the DB at call time and wires the cross-instance locked refresh
            // handler. Verifying with tokens bulk-read minutes earlier and a raw
            // unlocked refresh can burn a rotated refresh token (invalid_grant)
            // and falsely revoke a healthy user.
            let createClient = deps?.createClient;
            if (!createClient) {
                const { createTeslaClientForSite } = await import('./tesla-client-factory');
                createClient = createTeslaClientForSite;
            }
            phase = 'client-construction';
            const client = await createClient(siteId);
            if (!client) {
                return await commitStatus('no_token', 'no-credentials');
            }

            try {
                phase = 'live-status';
                await client.getLiveStatus(siteId);
            } catch (err: unknown) {
                console.error(`[UserRepo] Error checking user ${user.id}:`, err);
                const errorMsg = err instanceof Error ? err.message : String(err);

                if (isTeslaAuthError(err)) {
                    return await commitStatus('error', 'fleet-access-rejected', err, errorMsg);
                }

                // Transient failure (Tesla 5xx, network, exhausted 429 retries):
                // record it but do NOT deactivate — is_active=false blocks every
                // authenticated route and JWT refresh, locking the user out over
                // a blip. auth_status='error' keeps the user in the cron's
                // "troubled" bucket so it re-verifies next run.
                return await commitStatus('error', 'transient-failure', err, errorMsg);
            }
            return await commitStatus('active', 'live-status-succeeded');
        } catch (error) {
            // Includes site lookup, client construction, and failed status writes.
            // A start without a completion also exposes platform termination.
            logEvent('error', 'tesla.user-verification.failed', {
                verificationId, siteId, ...snapshot, phase, reason: 'verification-interrupted',
                durationMs: Date.now() - started, error,
            });
            flushLogEvents();
            throw error;
        }
    }

    async verifyAllUserStatuses() {
        const users = await this.getAllUsers();
        logEvent('info', 'tesla.user-verification.batch-started', { userCount: users.length });
        let activeCount = 0;
        let inactiveCount = 0;
        let errorCount = 0;
        let skipCount = 0;

        const staleThreshold = new Date(Date.now() - 24 * 60 * 60 * 1000);

        for (const user of users) {
            // Optimization: Skip if checked recently AND active
            const lastChecked = user.last_checked_at ? new Date(user.last_checked_at) : null;
            const isStale = !lastChecked || lastChecked < staleThreshold;
            const isTroubled = user.auth_status !== 'active' || !user.is_active;

            if (!isStale && !isTroubled) {
                skipCount++;
                logEvent('info', 'tesla.user-verification.skipped', {
                    siteIds: user.sites.map(site => site.id),
                    reason: 'recently-checked-active', selectedAuthStatus: user.auth_status,
                    selectedIsActive: user.is_active, selectedLastCheckedAt: lastChecked?.toISOString(),
                });
                activeCount++; // Still considered active
                continue;
            }

            const result = await this.verifyUserStatus(user);
            if (result.status === 'active') {
                activeCount++;
            } else if (result.status === 'error') {
                // Transient failure: user stays active; re-verified next run.
                errorCount++;
            } else {
                inactiveCount++;
            }
            // Brief pause to be nice to API
            await new Promise(r => setTimeout(r, 200));
        }

        console.log(`[UserRepo] verifyAllUserStatuses: total=${users.length}, skipped=${skipCount}, active=${activeCount}, inactive=${inactiveCount}, errors=${errorCount}`);

        return {
            total: users.length,
            skipped: skipCount,
            active: activeCount,
            inactive: inactiveCount,
            errors: errorCount
        };
    }
}

// Backwards-compat thin wrapper — required because callers used this from
// import-time React Server Component context. The wrapper for `isUserActive`
// preserves React's per-request cache identity.
export const isUserActive = cache(async (userId: string): Promise<boolean> => {
    const repo = new UserRepo();
    return repo.isActive(userId);
});

