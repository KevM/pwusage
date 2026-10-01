import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { pool } from './db';
import { validateHistoryRetention, type HistoryRetentionPolicy, type ValidHistoryRetentionPolicy } from './history-retention';

export interface RetentionQueryable {
    query<Row extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<QueryResult<Row>>;
}
export interface RetentionDatabase extends RetentionQueryable {
    connect(): Promise<RetentionQueryable & Pick<PoolClient, 'release'>>;
}
export interface RetentionSite { siteId: string; userId: string | null; timezone: string; policy: ValidHistoryRetentionPolicy | null }
interface SiteRow extends HistoryRetentionPolicy { id: string; user_id: string | null; timezone: string }
export interface RetentionCount { siteId: string; energy: number; tags: number }
export interface RetentionBatch { energy: number; tags: number }

export class HistoryRetentionRepo {
    constructor(private database: RetentionDatabase = pool) {}

    private async readQuery<Row extends QueryResultRow>(sql: string, params: unknown[], timeoutMs?: number): Promise<QueryResult<Row>> {
        if (timeoutMs === undefined) return this.database.query<Row>(sql, params);
        if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error('Retention read budget exhausted');
        const client = await this.database.connect();
        try {
            await client.query('BEGIN READ ONLY');
            await client.query("SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', $1, true)", [String(timeoutMs)]);
            const result = await client.query<Row>(sql, params);
            await client.query('COMMIT');
            return result;
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally { client.release(); }
    }

    async listSites(timeoutMs?: number): Promise<RetentionSite[]> {
        const result = await this.readQuery<SiteRow>(`
            SELECT s.id, s.user_id, s.timezone, u.history_retention_days,
                u.history_retention_grace_until, u.history_retention_transition_pending
            FROM "Site" s LEFT JOIN "User" u ON u.id = s.user_id ORDER BY s.id
        `, [], timeoutMs);
        return result.rows.map(row => ({ siteId: row.id, userId: row.user_id, timezone: row.timezone,
            policy: row.user_id ? validateHistoryRetention(row) : null }));
    }

    async preview(targets: Array<{ siteId: string; cutoff: string }>, timeoutMs?: number): Promise<RetentionCount[]> {
        if (!targets.length) return [];
        const result = await this.readQuery<{ site_id: string; energy: number; tags: number }>(`
            SELECT target.site_id,
                (SELECT COUNT(*)::int FROM "EnergyData" e WHERE e.site_id = target.site_id AND e.timestamp < target.cutoff) AS energy,
                (SELECT COUNT(*)::int FROM "LoadTag" t WHERE t.site_id = target.site_id AND t.end_time < target.cutoff) AS tags
            FROM jsonb_to_recordset($1::jsonb) AS target(site_id text, cutoff timestamptz)
        `, [JSON.stringify(targets.map(target => ({ site_id: target.siteId, cutoff: target.cutoff })))], timeoutMs);
        return result.rows.map(row => ({ siteId: row.site_id, energy: row.energy, tags: row.tags }));
    }

    /** Short per-site transaction: policy/ownership cannot change during either deletion. */
    async withLockedSite(siteId: string, callback: (site: RetentionSite | null, db: RetentionQueryable) => Promise<RetentionBatch>, timeoutMs = 5000): Promise<RetentionBatch> {
        const client = await this.database.connect();
        try {
            await client.query('BEGIN');
            await client.query("SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', '1000', true)", [String(timeoutMs)]);
            const sites = await client.query<{ id: string; user_id: string | null; timezone: string }>('SELECT id, user_id, timezone FROM "Site" WHERE id = $1 FOR SHARE', [siteId]);
            const row = sites.rows[0];
            let site: RetentionSite | null = null;
            if (row?.user_id) {
                const users = await client.query<HistoryRetentionPolicy>(`
                    SELECT history_retention_days, history_retention_grace_until, history_retention_transition_pending
                    FROM "User" WHERE id = $1 FOR SHARE
                `, [row.user_id]);
                if (!users.rows[0]) throw new Error('Retention account not found');
                site = { siteId: row.id, userId: row.user_id, timezone: row.timezone, policy: validateHistoryRetention(users.rows[0]) };
            }
            const result = await callback(site, client);
            await client.query('COMMIT');
            return result;
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally { client.release(); }
    }
}
