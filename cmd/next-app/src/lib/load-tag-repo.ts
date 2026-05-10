import { pool } from './db';
import { LoadTag } from './db';

export class LoadTagRepo {
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

    async cleanupOldTags(cutoffDate: Date): Promise<{ tagsDeleted: number }> {
        const tagsRes = await pool.query(`
            DELETE FROM "LoadTag"
            WHERE end_time < $1
        `, [cutoffDate]);

        return {
            tagsDeleted: tagsRes.rowCount || 0
        };
    }
}