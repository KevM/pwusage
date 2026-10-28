import { pool } from './db';
import type { SolarLayoutResult } from './solar-layout/detect';
import { SOLAR_FORECAST_BETA_ROLE } from './solar-forecast-beta';

export type SolarLayoutStatus = 'pending' | 'detected' | 'not-enough-history' | 'low-confidence' | 'failed';

export interface SiteSolarLayoutRow {
    siteId: string;
    latitude: number | null;
    longitude: number | null;
    locationSetAt: Date | null;
    result: SolarLayoutResult | null;
    status: SolarLayoutStatus;
    detectedAt: Date | null;
    attemptedAt: Date | null;
    detectorVersion: number | null;
}

export interface DueSite {
    siteId: string;
    timezone: string;
    latitude: number;
    longitude: number;
}

/** Locations are kept to ~1 km; a finer fix is never stored. */
export function roundCoordinate(value: number): number {
    return Math.round(value * 100) / 100;
}

function toNumber(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

export class SolarLayoutRepo {
    async setLocation(siteId: string, latitude: number, longitude: number): Promise<void> {
        await pool.query(`
            INSERT INTO "SiteSolarLayout" (site_id, latitude, longitude, location_set_at, status)
            VALUES ($1, $2, $3, now(), 'pending')
            ON CONFLICT (site_id) DO UPDATE
            SET latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude, location_set_at = now(),
                status = 'pending', attempted_at = NULL
        `, [siteId, roundCoordinate(latitude), roundCoordinate(longitude)]);
    }

    async get(siteId: string): Promise<SiteSolarLayoutRow | null> {
        const res = await pool.query(`
            SELECT site_id, latitude, longitude, location_set_at, result, status, detected_at, attempted_at, detector_version
            FROM "SiteSolarLayout" WHERE site_id = $1
        `, [siteId]);
        const r = res.rows[0];
        if (!r) return null;
        return {
            siteId: r.site_id,
            latitude: toNumber(r.latitude),
            longitude: toNumber(r.longitude),
            locationSetAt: r.location_set_at ?? null,
            result: (r.result ?? null) as SolarLayoutResult | null,
            status: r.status,
            detectedAt: r.detected_at ?? null,
            attemptedAt: r.attempted_at ?? null,
            detectorVersion: toNumber(r.detector_version),
        };
    }

    /**
     * Stores a detection. A `failed` result keeps the previous result and its
     * status (when there is one) and leaves detected_at alone, so the site is
     * retried after 24 hours rather than 30 days.
     */
    async saveResult(siteId: string, result: SolarLayoutResult, detectorVersion: number): Promise<void> {
        await pool.query(`
            UPDATE "SiteSolarLayout"
            SET result = CASE WHEN $2 = 'failed' THEN result ELSE $3::jsonb END,
                status = CASE WHEN $2 = 'failed' AND result IS NOT NULL THEN status ELSE $2 END,
                detected_at = CASE WHEN $2 = 'failed' THEN detected_at ELSE now() END,
                detector_version = CASE WHEN $2 = 'failed' THEN detector_version ELSE $4 END,
                attempted_at = now()
            WHERE site_id = $1
        `, [siteId, result.status, JSON.stringify(result), detectorVersion]);
    }

    async recordFailure(siteId: string): Promise<void> {
        await pool.query(`
            UPDATE "SiteSolarLayout" SET attempted_at = now()
            WHERE site_id = $1
        `, [siteId]);
    }

    async listDue(limit: number, now: Date): Promise<DueSite[]> {
        const res = await pool.query(`
            SELECT l.site_id, s.timezone, l.latitude, l.longitude
            FROM "SiteSolarLayout" l
            JOIN "Site" s ON s.id = l.site_id
            JOIN "User" u ON u.id = s.user_id
            WHERE '${SOLAR_FORECAST_BETA_ROLE}' = ANY(u.roles)
              AND l.latitude IS NOT NULL AND l.longitude IS NOT NULL
              AND (l.detected_at IS NULL OR l.detected_at < $1::timestamptz - interval '30 days')
              AND (l.attempted_at IS NULL OR l.attempted_at < $1::timestamptz - interval '24 hours')
            ORDER BY l.detected_at NULLS FIRST, l.attempted_at NULLS FIRST
            LIMIT $2
        `, [now, limit]);
        return res.rows.map(r => ({
            siteId: r.site_id,
            timezone: r.timezone,
            latitude: Number(r.latitude),
            longitude: Number(r.longitude),
        }));
    }
}
