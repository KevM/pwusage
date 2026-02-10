import { pool, User, Site } from './db';

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
            ORDER BY u.is_active DESC, last_data_import DESC
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
}
