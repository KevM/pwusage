import { cache } from 'react';
import { pool, User, Site } from './db';
import { TeslaClient, isTeslaAuthError } from './tesla-client';
import { latestStoredSampleSql } from './latest-stored-sample-sql';

export interface UserWithSites extends User {
    sites: Site[];
    has_trmnl_integration?: boolean;
}

export interface UserAuthState {
    isActive: boolean;
    sessionVersion: number;
    roles: string[];
}

export class UserRepo {
    // === Queries ===
    async getByAccessToken(token: string): Promise<{ id: string, email?: string, roles?: string[] } | null> {
        const res = await pool.query('SELECT id, email, roles FROM "User" WHERE access_token = $1', [token]);
        if (res.rows.length === 0) return null;
        return res.rows[0];
    }

    async getTokens(userId: string): Promise<{ access_token: string, refresh_token: string } | null> {
        const res = await pool.query('SELECT access_token, refresh_token FROM "User" WHERE id = $1', [userId]);
        if (res.rows.length === 0) return null;
        return res.rows[0];
    }

    async getTokensForSite(siteId: string): Promise<{ access_token: string, refresh_token: string, user_id: string } | null> {
        const res = await pool.query(`
            SELECT u.access_token, u.refresh_token, u.id as user_id
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
            SELECT u.id, u.email, u.roles, u.is_active, u.auth_status, u.last_checked_at, u.created_at${tokenCols}, 
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
    }): Promise<void> {
        await pool.query(`
            INSERT INTO "User" (id, email, access_token, refresh_token, token_expires_at, auth_status, is_active)
            VALUES ($1, $2, $3, $4, $5, 'active', true)
            ON CONFLICT (id) DO UPDATE SET
                access_token = EXCLUDED.access_token,
                refresh_token = EXCLUDED.refresh_token,
                email = COALESCE(EXCLUDED.email, "User".email),
                auth_status = 'active',
                is_active = true
        `, [params.userId, params.email, params.accessToken, params.refreshToken, params.tokenExpiresAt]);
    }

    async updateTokens(userId: string, accessToken: string, refreshToken: string): Promise<void> {
        await pool.query(
            'UPDATE "User" SET access_token = $1, refresh_token = $2 WHERE id = $3',
            [accessToken, refreshToken, userId]
        );
    }

    async verifyUserStatus(
        user: Pick<User, 'id'>,
        deps?: { createClient?: (siteId: string) => Promise<Pick<TeslaClient, 'getLiveStatus'> | null> }
    ): Promise<{ status: string; error?: string }> {
        // Get user's sites to test with
        const sitesRes = await pool.query('SELECT id FROM "Site" WHERE user_id = $1 LIMIT 1', [user.id]);
        if (sitesRes.rows.length === 0) {
            // No sites - can't verify credentials
            await this.updateUserStatus(user.id, 'no_sites', false);
            return { status: 'no_sites' };
        }
        const siteId = sitesRes.rows[0].id;

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
        const client = await createClient(siteId);
        if (!client) {
            await this.updateUserStatus(user.id, 'no_token', false);
            return { status: 'no_token' };
        }

        try {
            await client.getLiveStatus(siteId);
            await this.updateUserStatus(user.id, 'active', true);
            return { status: 'active' };
        } catch (err: unknown) {
            console.error(`[UserRepo] Error checking user ${user.id}:`, err);
            const errorMsg = err instanceof Error ? err.message : String(err);

            if (isTeslaAuthError(err)) {
                await this.updateUserStatus(user.id, 'revoked', false);
                return { status: 'revoked', error: errorMsg };
            }

            // Transient failure (Tesla 5xx, network, exhausted 429 retries):
            // record it but do NOT deactivate — is_active=false blocks every
            // authenticated route and JWT refresh, locking the user out over
            // a blip. auth_status='error' keeps the user in the cron's
            // "troubled" bucket so it re-verifies next run.
            await this.updateUserStatus(user.id, 'error', true);
            return { status: 'error', error: errorMsg };
        }
    }

    async verifyAllUserStatuses() {
        const users = await this.getAllUsers();
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

