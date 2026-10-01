import type { RetentionQueryable } from './history-retention-repo';
import { pool } from './db';
import { LoadTag } from './db';

export class LoadTagRepo {
    // === Queries ===
    async getLoadTags(siteId: string, start: Date, end: Date): Promise<LoadTag[]> {
        const res = await pool.query(`
            SELECT * FROM "LoadTag"
            WHERE site_id = $1
            AND start_time >= $2
            AND end_time <= $3
        `, [siteId, start, end]);

        return res.rows.map(r => ({
            ...r,
            start_time: new Date(r.start_time),
            end_time: new Date(r.end_time),
            created_at: new Date(r.created_at)
        }));
    }

    // === Commands ===
    async addLoadTag(siteId: string, start: Date, end: Date, tag: string) {
        const exists = await pool.query(`
            SELECT 1 FROM "LoadTag" 
            WHERE site_id = $1 AND start_time = $2 AND end_time = $3 AND tag = $4
        `, [siteId, start, end, tag]);

        if (exists.rowCount && exists.rowCount > 0) return;

        await pool.query(`
            INSERT INTO "LoadTag" (site_id, start_time, end_time, tag)
            VALUES ($1, $2, $3, $4)
        `, [siteId, start, end, tag]);
    }

    async removeLoadTag(siteId: string, start: Date, end: Date, tag: string) {
        await pool.query(`
            DELETE FROM "LoadTag"
            WHERE site_id = $1 AND start_time = $2 AND end_time = $3 AND tag = $4
        `, [siteId, start, end, tag]);
    }

    async deleteExpiredBatch(siteId: string, cutoff: Date, limit: number, db: RetentionQueryable = pool): Promise<number> {
        if (!Number.isInteger(limit) || limit < 1 || limit > 5000) throw new Error('Invalid retention batch size');
        const result = await db.query(`
            WITH candidates AS (
                SELECT id FROM "LoadTag" WHERE site_id = $1 AND end_time < $2
                ORDER BY end_time, id LIMIT $3 FOR UPDATE SKIP LOCKED
            )
            DELETE FROM "LoadTag" target USING candidates WHERE target.id = candidates.id
        `, [siteId, cutoff, limit]);
        return result.rowCount ?? 0;
    }

}
