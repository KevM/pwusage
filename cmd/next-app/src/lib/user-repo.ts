import { pool, User, Site } from './db';

export interface UserWithSites extends User {
    sites: Site[];
}

export class UserRepo {
    async getAllUsers(): Promise<UserWithSites[]> {
        // Fetch users
        const userRes = await pool.query('SELECT * FROM "User" ORDER BY created_at DESC');
        const users = userRes.rows as User[];

        // Fetch all sites (optimization: fetch all and map in memory instead of N+1 queries)
        const siteRes = await pool.query('SELECT * FROM "Site"');
        const sites = siteRes.rows as Site[];

        // Map sites to users
        const usersWithSites: UserWithSites[] = users.map(user => {
            const userSites = sites.filter(s => s.user_id === user.id);
            return {
                ...user,
                sites: userSites
            };
        });

        return usersWithSites;
    }
}
