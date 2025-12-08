import { pool, TrmnlInstallation } from './db';

export class TrmnlService {
    async createInstallation(accessToken: string, siteId: string, uuid: string | null = null, refreshToken?: string): Promise<number> {
        const query = `
            INSERT INTO "TrmnlInstallation" (access_token, site_id, uuid, refresh_token)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT(access_token) DO UPDATE SET 
                site_id = EXCLUDED.site_id,
                uuid = COALESCE(EXCLUDED.uuid, "TrmnlInstallation".uuid),
                refresh_token = COALESCE(EXCLUDED.refresh_token, "TrmnlInstallation".refresh_token)
            RETURNING id
        `;
        const { rows } = await pool.query(query, [accessToken, siteId, uuid, refreshToken || null]);
        return rows[0].id;
    }

    async updateInstallation(accessToken: string, uuid: string, pluginSettingId: number) {
        await pool.query(`
            UPDATE "TrmnlInstallation"
            SET uuid = $1, plugin_setting_id = $2
            WHERE access_token = $3
        `, [uuid, pluginSettingId, accessToken]);
    }

    async updateRefreshToken(uuid: string, refreshToken: string) {
        await pool.query('UPDATE "TrmnlInstallation" SET refresh_token = $1 WHERE uuid = $2', [refreshToken, uuid]);
    }

    async getInstallationByToken(accessToken: string): Promise<TrmnlInstallation | undefined> {
        const { rows } = await pool.query('SELECT * FROM "TrmnlInstallation" WHERE access_token = $1', [accessToken]);
        return rows[0] as TrmnlInstallation | undefined;
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
