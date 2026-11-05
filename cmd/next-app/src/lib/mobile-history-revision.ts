import { pool } from './db';
import { HAS_SAMPLES_SQL } from './prototypes/compact-history-store';

export interface MobileHistoryRevision {
    revision: string;
    latest: Date | null;
    hasFutureSamples: boolean;
    priorRevision: string;
}

/** A single row of archive metadata. Keep bulk history off unchanged mobile requests. */
export async function readMobileHistoryRevision(
    siteId: string, start: Date, end: Date, today = start, db: Pick<typeof pool, 'query'> = pool
): Promise<MobileHistoryRevision> {
    const { rows } = await db.query<MobileHistoryRevision>(`
        SELECT md5(coalesce(string_agg(version, ',' ORDER BY day_start), '')) AS revision,
            -- A record ending past the boundary still holds samples up to it.
            max(least(last_timestamp, $3::timestamptz)) AS latest,
            coalesce(bool_or(last_timestamp IS NULL OR last_timestamp >= $3), false) AS "hasFutureSamples",
            md5(coalesce(string_agg(version, ',' ORDER BY day_start)
                FILTER (WHERE day_end <= $4), '')) AS "priorRevision"
        FROM (
            SELECT day_start, day_end, last_timestamp,
                extract(epoch FROM day_start)::text || ':' || revision::text
                    || ':' || coalesce(status, '') AS version
            FROM "EnergyDayArchive"
            WHERE site_id = $1 AND day_start >= $2::timestamptz - interval '2 days'
                AND day_start < $3 AND day_end > $2 AND ${HAS_SAMPLES_SQL()}
        ) days
    `, [siteId, start, end, today]);
    return rows[0];
}
