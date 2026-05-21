import { pool, TrmnlInstallation } from './db';
import { SiteRepo } from './site-repo';

export class TrmnlInstallationRepo {
    // === Queries (Read Operations) ===
    async findByUuid(uuid: string): Promise<TrmnlInstallation | undefined> {
        const { rows } = await pool.query('SELECT * FROM "TrmnlInstallation" WHERE uuid = $1', [uuid]);
        return rows[0] as TrmnlInstallation | undefined;
    }

    async findByUuidWithSite(
        uuid: string,
        options: { includeTokens?: boolean } = {}
    ): Promise<{ installation: TrmnlInstallation; site: import('./db').SiteWithTariffs } | undefined> {
        const installation = await this.findByUuid(uuid);
        if (!installation) return undefined;

        const site = await new SiteRepo().getSite(installation.site_id, options);
        if (!site) return undefined;

        if (!options.includeTokens) {
            // Strip TRMNL tokens from the returned installation when not requested
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const { access_token: _at, refresh_token: _rt, ...safe } = installation;
            return { installation: safe as TrmnlInstallation, site };
        }

        return { installation, site };
    }

    async findBySiteId(siteId: string): Promise<TrmnlInstallation | undefined> {
        const { rows } = await pool.query(`
            SELECT * FROM "TrmnlInstallation" 
            WHERE site_id = $1 
            ORDER BY (plugin_setting_id IS NOT NULL) DESC, created_at DESC, id DESC
            LIMIT 1
        `, [siteId]);
        return rows[0] as TrmnlInstallation | undefined;
    }

    async findPendingByPluginId(pluginSettingId: number): Promise<TrmnlInstallation | undefined> {
        const { rows } = await pool.query(
            'SELECT * FROM "TrmnlInstallation" WHERE plugin_setting_id = $1 AND uuid IS NULL',
            [pluginSettingId]
        );
        return rows[0] as TrmnlInstallation | undefined;
    }

    async findLatestLoosePending(): Promise<TrmnlInstallation | undefined> {
        const { rows } = await pool.query(`
            SELECT * FROM "TrmnlInstallation" 
            WHERE uuid IS NULL AND plugin_setting_id IS NULL 
            ORDER BY created_at DESC 
            LIMIT 1
        `);
        return rows[0] as TrmnlInstallation | undefined;
    }

    // === Commands (Write/Mutate Operations) ===
    async create(
        siteId: string,
        uuid: string | null = null,
        pluginSettingId: number | null = null,
        json: unknown = null,
        accessToken: string | null = null
    ): Promise<number> {
        const params = [siteId, uuid || null, pluginSettingId, json, accessToken];
        const query = uuid ? `
            INSERT INTO "TrmnlInstallation" (site_id, uuid, plugin_setting_id, json, access_token)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT(uuid) DO UPDATE SET 
                site_id = EXCLUDED.site_id,
                plugin_setting_id = COALESCE(EXCLUDED.plugin_setting_id, "TrmnlInstallation".plugin_setting_id),
                json = COALESCE(EXCLUDED.json, "TrmnlInstallation".json),
                access_token = COALESCE(EXCLUDED.access_token, "TrmnlInstallation".access_token)
            RETURNING id
        ` : `
            INSERT INTO "TrmnlInstallation" (site_id, uuid, plugin_setting_id, json, access_token)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id
        `;
        const { rows } = await pool.query(query, params);
        return rows[0].id;
    }

    async upsertSettings(uuid: string, siteId: string, json: unknown, pluginSettingId: number | null): Promise<number> {
        const query = `
            INSERT INTO "TrmnlInstallation" (uuid, site_id, json, plugin_setting_id)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT(uuid) DO UPDATE SET 
                site_id = EXCLUDED.site_id,
                json = EXCLUDED.json,
                plugin_setting_id = COALESCE(EXCLUDED.plugin_setting_id, "TrmnlInstallation".plugin_setting_id)
            RETURNING id
        `;
        const { rows } = await pool.query(query, [uuid, siteId, json, pluginSettingId]);
        return rows[0].id;
    }

    async updatePluginId(uuid: string, pluginSettingId: number): Promise<void> {
        await pool.query(
            'UPDATE "TrmnlInstallation" SET plugin_setting_id = $1 WHERE uuid = $2',
            [pluginSettingId, uuid]
        );
    }

    async updateJson(id: number, json: unknown): Promise<void> {
        await pool.query(
            'UPDATE "TrmnlInstallation" SET json = $1 WHERE id = $2',
            [json, id]
        );
    }

    async claimPendingById(id: number, uuid: string, pluginSettingId: number, json: unknown): Promise<void> {
        await pool.query(`
            UPDATE "TrmnlInstallation"
            SET uuid = $1, plugin_setting_id = $2, json = $3
            WHERE id = $4
        `, [uuid, pluginSettingId, json, id]);
    }

    async claimPending(pluginSettingId: number, uuid: string, json: unknown): Promise<void> {
        await pool.query(`
            UPDATE "TrmnlInstallation"
            SET uuid = $1, json = $2
            WHERE plugin_setting_id = $3 AND uuid IS NULL
        `, [uuid, json, pluginSettingId]);
    }

    async delete(uuid: string): Promise<void> {
        await pool.query('DELETE FROM "TrmnlInstallation" WHERE uuid = $1', [uuid]);
    }
}
