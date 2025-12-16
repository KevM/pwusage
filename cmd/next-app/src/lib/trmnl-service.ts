import { pool, TrmnlInstallation } from './db';

export class TrmnlService {
    async createInstallation(siteId: string, uuid: string | null = null, pluginSettingId: number | null = null, details: unknown = null, accessToken: string | null = null): Promise<number> {
        // If UUID is null, we are in "Pending" mode. We try to insert based on plugin_setting_id mostly.
        // But table has UNIQUE constraint on UUID? (It allows multiple nulls? Yes standard SQL does, but let's be safe).

        let query = '';
        const params: (string | number | unknown | null)[] = [siteId, uuid || null, pluginSettingId, details, accessToken];

        if (uuid) {
            query = `
                INSERT INTO "TrmnlInstallation" (site_id, uuid, plugin_setting_id, json, access_token)
                VALUES ($1, $2, $3, $4, $5)
                ON CONFLICT(uuid) DO UPDATE SET 
                    site_id = EXCLUDED.site_id,
                    plugin_setting_id = COALESCE(EXCLUDED.plugin_setting_id, "TrmnlInstallation".plugin_setting_id),
                    json = COALESCE(EXCLUDED.json, "TrmnlInstallation".json),
                    access_token = COALESCE(EXCLUDED.access_token, "TrmnlInstallation".access_token)
                RETURNING id
            `;
        } else {
            // Pending record creation. 
            // We should check if one exists for this plugin_setting_id to avoid duplicates if user clicks twice?
            // Or assumes plugin_setting_id is unique enough (it's not unique in DB currently).
            // Let's just INSERT. The Webhook will clean it up.
            query = `
                INSERT INTO "TrmnlInstallation" (site_id, uuid, plugin_setting_id, json, access_token)
                VALUES ($1, $2, $3, $4, $5)
                RETURNING id
             `;
        }

        const { rows } = await pool.query(query, params);
        return rows[0].id;
    }

    async updateInstallation(uuid: string, pluginSettingId: number) {
        await pool.query(`
            UPDATE "TrmnlInstallation"
            SET plugin_setting_id = $1
            WHERE uuid = $2
        `, [pluginSettingId, uuid]);
    }

    async getInstallationByUuid(uuid: string): Promise<TrmnlInstallation | undefined> {
        // Prioritize installations that have a site_id if multiples exist (though uuid should be unique, "zombies" might share it if my logic was flawed, or just hygiene)
        // Actually, UUID is unique constraint in DB? Let's check schema later.
        // Assuming UUID is unique, but let's be safe.
        const { rows } = await pool.query('SELECT * FROM "TrmnlInstallation" WHERE uuid = $1', [uuid]);
        return rows[0] as TrmnlInstallation | undefined;
    }

    async getInstallationBySiteId(siteId: string): Promise<TrmnlInstallation | undefined> {
        const { rows } = await pool.query(`
            SELECT * FROM "TrmnlInstallation" 
            WHERE site_id = $1 
            ORDER BY uuid DESC NULLS LAST
            LIMIT 1
        `, [siteId]);
        return rows[0] as TrmnlInstallation | undefined;
    }

    async deleteInstallation(uuid: string) {
        await pool.query('DELETE FROM "TrmnlInstallation" WHERE uuid = $1', [uuid]);
    }

    async exchangeCodeForToken(code: string, clientId: string, clientSecret: string): Promise<{ access_token: string, user_uuid?: string, uuid?: string, user?: { uuid?: string } }> {
        const response = await fetch('https://usetrmnl.com/oauth/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                code,
                client_id: clientId,
                client_secret: clientSecret,
                grant_type: 'authorization_code'
            })
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Failed to exchange token: ${error}`);
        }

        const data = await response.json();
        return data;
    }

    async getInstallationByPendingPluginId(pluginSettingId: number): Promise<TrmnlInstallation | undefined> {
        const { rows } = await pool.query('SELECT * FROM "TrmnlInstallation" WHERE plugin_setting_id = $1 AND uuid IS NULL', [pluginSettingId]);
        return rows[0] as TrmnlInstallation | undefined;
    }

    async getLatestLoosePendingInstallation(): Promise<TrmnlInstallation | undefined> {
        // Find most recent installation with NO UUID and NO Plugin ID (created by Loose Link fallback)
        const { rows } = await pool.query(`
            SELECT * FROM "TrmnlInstallation" 
            WHERE uuid IS NULL AND plugin_setting_id IS NULL 
            ORDER BY created_at DESC 
            LIMIT 1
        `);
        return rows[0] as TrmnlInstallation | undefined;
    }

    async claimPendingInstallationById(id: number, uuid: string, pluginSettingId: number, json: unknown) {
        await pool.query(`
            UPDATE "TrmnlInstallation"
            SET uuid = $1, plugin_setting_id = $2, json = $3
            WHERE id = $4
        `, [uuid, pluginSettingId, json, id]);
    }

    async claimPendingInstallation(pluginSettingId: number, uuid: string, json: unknown) {
        await pool.query(`
            UPDATE "TrmnlInstallation"
            SET uuid = $1, json = $2
            WHERE plugin_setting_id = $3 AND uuid IS NULL
        `, [uuid, json, pluginSettingId]);
    }

    async fetchMe(accessToken: string): Promise<{ uuid: string }> {
        const response = await fetch('https://usetrmnl.com/api/me', {
            headers: { 'Authorization': `Bearer ${accessToken}` }
        });

        if (!response.ok) {
            const body = await response.text();
            throw new Error(`Failed to fetch user info from Trmnl: ${response.status} ${body}`);
        }

        return await response.json();
    }
}
