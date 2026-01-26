
import { getDb } from './db';

export interface SystemAnnouncement {
    id: number;
    title: string;
    content: string;
    created_at: Date;
    author_id?: string;
}

export class AnnouncementRepo {
    async create(title: string, content: string, authorId?: string): Promise<SystemAnnouncement> {
        const query = `
            INSERT INTO "SystemAnnouncement" (title, content, author_id)
            VALUES ($1, $2, $3)
            RETURNING *
        `;
        const values = [title, content, authorId];
        const result = await getDb().query(query, values);
        return result.rows[0];
    }

    async getAll(limit: number = 50): Promise<SystemAnnouncement[]> {
        const query = `
            SELECT * FROM "SystemAnnouncement"
            ORDER BY created_at DESC
            LIMIT $1
        `;
        const result = await getDb().query(query, [limit]);
        return result.rows;
    }

    async delete(id: number): Promise<void> {
        const query = `DELETE FROM "SystemAnnouncement" WHERE id = $1`;
        await getDb().query(query, [id]);
    }

    async update(id: number, title: string, content: string): Promise<SystemAnnouncement | null> {
        const query = `
            UPDATE "SystemAnnouncement"
            SET title = $2, content = $3, created_at = NOW()
            WHERE id = $1
            RETURNING *
        `;
        const result = await getDb().query(query, [id, title, content]);
        return result.rows[0] || null;
    }

    async getLatest(): Promise<SystemAnnouncement | null> {
        const query = `
            SELECT * FROM "SystemAnnouncement"
            ORDER BY created_at DESC
            LIMIT 1
        `;
        const result = await getDb().query(query);
        return result.rows[0] || null;
    }
}
