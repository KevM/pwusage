
import { getDb } from './db';

export interface SystemAnnouncement {
    id: string;
    title: string;
    content: string;
    created_at: Date;
    updated_at: Date;
    author_id?: string;
    discord_message_id?: string;
}

export class AnnouncementRepo {
    async create(title: string, content: string, authorId?: string, discordMessageId?: string, createdAt?: Date): Promise<SystemAnnouncement> {
        const query = `
            INSERT INTO "SystemAnnouncement" (title, content, author_id, discord_message_id, created_at, updated_at)
            VALUES ($1, $2, $3, $4, COALESCE($5, NOW()), NOW())
            RETURNING *
        `;
        const values = [title, content, authorId, discordMessageId, createdAt];
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

    async delete(id: string): Promise<void> {
        const query = `DELETE FROM "SystemAnnouncement" WHERE id = $1`;
        await getDb().query(query, [id]);
    }

    async update(id: string, title: string, content: string, discordMessageId?: string, createdAt?: Date): Promise<SystemAnnouncement | null> {
        const query = `
            UPDATE "SystemAnnouncement"
            SET title = $2, content = $3, discord_message_id = COALESCE($4, discord_message_id), created_at = COALESCE($5, created_at), updated_at = NOW()
            WHERE id = $1
            RETURNING *
        `;
        const result = await getDb().query(query, [id, title, content, discordMessageId, createdAt]);
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

    async getById(id: string): Promise<SystemAnnouncement | null> {
        const query = `SELECT * FROM "SystemAnnouncement" WHERE id = $1`;
        const result = await getDb().query(query, [id]);
        return result.rows[0] || null;
    }
}
