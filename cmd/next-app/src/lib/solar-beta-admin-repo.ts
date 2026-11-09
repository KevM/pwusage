import { pool } from './db';
import { SOLAR_FORECAST_BETA_ROLE } from './solar-forecast-beta';
import { siteMembershipEnabled } from './site-membership-flag';

export interface SolarBetaSite {
    userId: string;
    email: string | null;
    authStatus: string | null;
    siteId: string;
    siteName: string;
}

/** Admin-only queries for granting the solar forecast beta. */
export class SolarBetaAdminRepo {
    /** Every site owned by a beta user. Locations and layouts live on the user's devices. */
    async listBetaSites(): Promise<SolarBetaSite[]> {
        const siteJoin = siteMembershipEnabled()
            ? 'JOIN "SiteMember" m ON m.user_id = u.id JOIN "Site" s ON s.id = m.site_id'
            : 'JOIN "Site" s ON s.user_id = u.id';
        const { rows } = await pool.query(`
            SELECT u.id AS user_id, u.email, u.auth_status, s.id AS site_id, s.name AS site_name
            FROM "User" u
            ${siteJoin}
            WHERE $1 = ANY(COALESCE(u.roles, '{}'))
            ORDER BY u.email, s.name
        `, [SOLAR_FORECAST_BETA_ROLE]);
        return rows.map((r) => ({
            userId: r.user_id,
            email: r.email ?? null,
            authStatus: r.auth_status ?? null,
            siteId: r.site_id,
            siteName: r.site_name,
        }));
    }

    /** The user who owns `siteId`, or whose email matches case-insensitively. */
    async findUserId(target: { siteId?: string; email?: string }): Promise<string | null> {
        const { rows } = target.siteId
            ? await pool.query(siteMembershipEnabled()
                ? 'SELECT user_id AS id FROM "SiteMember" WHERE site_id = $1 LIMIT 2'
                : 'SELECT user_id AS id FROM "Site" WHERE id = $1', [target.siteId])
            : await pool.query('SELECT id FROM "User" WHERE lower(email) = $1 LIMIT 2', [target.email]);
        return rows.length === 1 ? rows[0].id ?? null : null;
    }

    /** Adds or removes the beta role; idempotent and leaves other roles alone. */
    async setBeta(userId: string, enabled: boolean): Promise<void> {
        await pool.query(enabled
            ? `UPDATE "User" SET roles = array_append(COALESCE(roles, '{}'), $2)
               WHERE id = $1 AND NOT ($2 = ANY(COALESCE(roles, '{}')))`
            : `UPDATE "User" SET roles = array_remove(roles, $2) WHERE id = $1`,
        [userId, SOLAR_FORECAST_BETA_ROLE]);
    }
}
