import { pool } from './db';
import { SOLAR_FORECAST_BETA_ROLE } from './solar-forecast-beta';
import type { SolarLayoutStatus, SolarLocationSource } from './solar-layout-repo';

export interface SolarBetaSite {
    userId: string;
    email: string | null;
    authStatus: string | null;
    siteId: string;
    siteName: string;
    latitude: number | null;
    longitude: number | null;
    locationSource: SolarLocationSource | null;
    status: SolarLayoutStatus | null;
    confidence: string | null;
    reasons: string[];
    planes: { azimuth: number; tilt: number; dcKwp: number }[];
    acClipKw: number | null;
    detectedAt: string | null;
    attemptedAt: string | null;
}

const toNumber = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

/** Admin-only queries for granting the solar forecast beta and seeding locations. */
export class SolarBetaAdminRepo {
    /** Every site owned by a beta user, with its stored location and latest detection. */
    async listBetaSites(): Promise<SolarBetaSite[]> {
        const { rows } = await pool.query(`
            SELECT u.id AS user_id, u.email, u.auth_status, s.id AS site_id, s.name AS site_name,
                   l.latitude, l.longitude, l.location_source, l.status, l.result, l.detected_at, l.attempted_at
            FROM "User" u
            JOIN "Site" s ON s.user_id = u.id
            LEFT JOIN "SiteSolarLayout" l ON l.site_id = s.id
            WHERE $1 = ANY(COALESCE(u.roles, '{}'))
            ORDER BY u.email, s.name
        `, [SOLAR_FORECAST_BETA_ROLE]);
        return rows.map((r) => ({
            userId: r.user_id,
            email: r.email ?? null,
            authStatus: r.auth_status ?? null,
            siteId: r.site_id,
            siteName: r.site_name,
            latitude: toNumber(r.latitude),
            longitude: toNumber(r.longitude),
            locationSource: (r.location_source ?? null) as SolarLocationSource | null,
            status: r.status ?? null,
            confidence: r.result?.confidence ?? null,
            reasons: r.result?.reasons ?? [],
            planes: (r.result?.planes ?? []).map((p: { azimuth: number; tilt: number; dcKwp: number }) => ({
                azimuth: p.azimuth, tilt: p.tilt, dcKwp: p.dcKwp,
            })),
            acClipKw: r.result?.acClipKw ?? null,
            detectedAt: r.detected_at ? new Date(r.detected_at).toISOString() : null,
            attemptedAt: r.attempted_at ? new Date(r.attempted_at).toISOString() : null,
        }));
    }

    /** The user who owns `siteId`, or whose email matches case-insensitively. */
    async findUserId(target: { siteId?: string; email?: string }): Promise<string | null> {
        const { rows } = target.siteId
            ? await pool.query('SELECT user_id AS id FROM "Site" WHERE id = $1', [target.siteId])
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

    async siteOwnerHasBeta(siteId: string): Promise<boolean> {
        const { rows } = await pool.query(`
            SELECT 1 FROM "Site" s JOIN "User" u ON u.id = s.user_id
            WHERE s.id = $1 AND $2 = ANY(COALESCE(u.roles, '{}'))
        `, [siteId, SOLAR_FORECAST_BETA_ROLE]);
        return rows.length > 0;
    }
}
