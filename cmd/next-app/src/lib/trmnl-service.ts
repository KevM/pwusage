import { db, TrmnlInstallation } from './db';

export class TrmnlService {
    async createInstallation(accessToken: string, siteId: string): Promise<number> {
        const stmt = db.prepare(`
            INSERT INTO TrmnlInstallation (access_token, site_id)
            VALUES (?, ?)
            ON CONFLICT(access_token) DO UPDATE SET site_id = excluded.site_id
        `);
        const result = stmt.run(accessToken, siteId);
        return result.lastInsertRowid as number;
    }

    async updateInstallation(accessToken: string, uuid: string, pluginSettingId: number) {
        db.prepare(`
            UPDATE TrmnlInstallation
            SET uuid = ?, plugin_setting_id = ?
            WHERE access_token = ?
        `).run(uuid, pluginSettingId, accessToken);
    }

    getInstallationByToken(accessToken: string): TrmnlInstallation | undefined {
        return db.prepare('SELECT * FROM TrmnlInstallation WHERE access_token = ?').get(accessToken) as TrmnlInstallation | undefined;
    }

    getInstallationByUuid(uuid: string): TrmnlInstallation | undefined {
        return db.prepare('SELECT * FROM TrmnlInstallation WHERE uuid = ?').get(uuid) as TrmnlInstallation | undefined;
    }

    async deleteInstallation(uuid: string) {
        db.prepare('DELETE FROM TrmnlInstallation WHERE uuid = ?').run(uuid);
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
