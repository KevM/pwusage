import { cache } from 'react';
import { pool, User, Site } from './db';
import { TeslaClient, isTeslaAuthError } from './tesla-client';

export interface UserWithSites extends User {
    sites: Site[];
    has_trmnl_integration?: boolean;
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

    async getById(userId: string): Promise<User | null> {
        const res = await pool.query('SELECT * FROM "User" WHERE id = $1', [userId]);
        if (res.rows.length === 0) return null;
        return res.rows[0] as User;
    }

    async getByEmail(email: string): Promise<User | null> {
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
                SELECT MAX(ed.timestamp)
                FROM "EnergyData" ed
                JOIN "Site" s ON s.id = ed.site_id
                WHERE s.user_id = u.id
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

    async verifyUserStatus(user: User): Promise<{ status: string; error?: string }> {
        // Skip if no tokens
        if (!user.access_token || !user.refresh_token) {
            await this.updateUserStatus(user.id, 'no_token', false);
            return { status: 'no_token' };
        }

        // Get user's sites to test with
        const sitesRes = await pool.query('SELECT id FROM "Site" WHERE user_id = $1 LIMIT 1', [user.id]);

        if (sitesRes.rows.length === 0) {
            // No sites - can't verify credentials
            await this.updateUserStatus(user.id, 'no_sites', false);
            return { status: 'no_sites' };
        }

        const siteId = sitesRes.rows[0].id;

        try {
            // Attempt to use the token
            const client = new TeslaClient({
                accessToken: user.access_token,
                refreshToken: user.refresh_token,
                tokenRefreshHandler: async (refreshToken) => {
                    const { refreshAccessToken } = await import('./tesla-auth');
                    return refreshAccessToken(refreshToken);
                },
                onTokenUpdate: async (newAccess, newRefresh) => {
                    await pool.query('UPDATE "User" SET access_token = $1, refresh_token = $2 WHERE id = $3', [newAccess, newRefresh, user.id]);
                    console.log(`[UserRepo] Refreshed tokens for user ${user.id}`);
                }
            });

            // Use site-specific API call instead of getUserInfo
            await client.getLiveStatus(siteId);

            // If we get here, it's active
            await this.updateUserStatus(user.id, 'active', true);
            return { status: 'active' };

        } catch (err: unknown) {
            console.error(`[UserRepo] Error checking user ${user.id}:`, err);

            let status = 'error';
            const errorMsg = err instanceof Error ? err.message : String(err);

            // If it's an auth error, mark inactive.
            if (isTeslaAuthError(err)) {
                status = 'revoked';
            }

            await this.updateUserStatus(user.id, status, false);
            return { status: status, error: errorMsg };
        }
    }

    async verifyAllUserStatuses() {
        const users = await this.getAllUsers({ includeTokens: true });
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
                errorCount++;
                inactiveCount++;
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

