import { pool, TrmnlInstallation } from './db';

export class TrmnlService {
    async createInstallation(siteId: string, uuid: string | null = null, pluginSettingId: number | null = null): Promise<number> {
        const query = `
            INSERT INTO "TrmnlInstallation" (site_id, uuid, plugin_setting_id)
            VALUES ($1, $2, $3)
            ON CONFLICT(uuid) DO UPDATE SET 
                site_id = EXCLUDED.site_id,
                plugin_setting_id = COALESCE(EXCLUDED.plugin_setting_id, "TrmnlInstallation".plugin_setting_id)
            RETURNING id
        `;
        const { rows } = await pool.query(query, [siteId, uuid || null, pluginSettingId]);
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
        const { rows } = await pool.query('SELECT * FROM "TrmnlInstallation" WHERE uuid = $1', [uuid]);
        return rows[0] as TrmnlInstallation | undefined;
    }

    async deleteInstallation(uuid: string) {
        await pool.query('DELETE FROM "TrmnlInstallation" WHERE uuid = $1', [uuid]);
    }

    async exchangeCodeForToken(code: string, clientId: string, clientSecret: string): Promise<string> {
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
        return data.access_token;
    }
}
