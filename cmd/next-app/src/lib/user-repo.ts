import { pool, User, Site } from './db';
import { TeslaClient } from './tesla-client';

export interface UserWithSites extends User {
    sites: Site[];
    has_trmnl_integration?: boolean;
}

export class UserRepo {
    async getAllUsers(): Promise<UserWithSites[]> {
        // Fetch users and check for Trmnl integration in a single query using subquery (efficiently handles the join logic)
        const userRes = await pool.query(`
            SELECT u.*, 
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
        const siteRes = await pool.query('SELECT * FROM "Site"');
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
            if (errorMsg.includes('401') || errorMsg.includes('login_required')) {
                status = 'revoked';
            }

            await this.updateUserStatus(user.id, status, false);
            return { status: status, error: errorMsg };
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
