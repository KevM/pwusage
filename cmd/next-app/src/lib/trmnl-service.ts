import { TrmnlInstallation } from './db';
import { TrmnlInstallationRepo } from './trmnl-installation-repo';

export class TrmnlService {
    private dbRepo = new TrmnlInstallationRepo();

    async createInstallation(siteId: string, uuid: string | null = null, pluginSettingId: number | null = null, details: unknown = null, accessToken: string | null = null): Promise<number> {
        return this.dbRepo.create(siteId, uuid, pluginSettingId, details, accessToken);
    }

    // Simplified in-memory cache for installations to avoid redundant DB hits during high-frequency polling
    private static getCache(): Map<string, { data: TrmnlInstallation, expires: number }> {
        const globalForTrmnl = global as unknown as { installationCache: Map<string, { data: TrmnlInstallation, expires: number }> };
        if (!globalForTrmnl.installationCache) {
            globalForTrmnl.installationCache = new Map();
        }
        return globalForTrmnl.installationCache;
    }

    private static readonly CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes for polled installations

    invalidateInstallationCache(uuid: string) {
        TrmnlService.getCache().delete(uuid);
    }

    async updateInstallation(uuid: string, pluginSettingId: number) {
        await this.dbRepo.updatePluginId(uuid, pluginSettingId);
        TrmnlService.getCache().delete(uuid);
    }

    async getInstallationByUuid(uuid: string, options: { includeTokens?: boolean } = {}): Promise<TrmnlInstallation | undefined> {
        const now = Date.now();
        const cached = TrmnlService.getCache().get(uuid);
        // Cache always includes tokens for simplicity, but we strip them if not requested
        let installation: TrmnlInstallation | undefined;

        if (cached && cached.expires > now) {
            installation = cached.data;
        } else {
            installation = await this.dbRepo.findByUuid(uuid);

            if (installation) {
                TrmnlService.getCache().set(uuid, { data: installation, expires: now + TrmnlService.CACHE_TTL_MS });
            }
        }

        if (installation && !options.includeTokens) {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const { access_token: _at, refresh_token: _rt, ...safe } = installation;
            return safe as TrmnlInstallation;
        }

        return installation;
    }

    async getInstallationBySiteId(siteId: string, options: { includeTokens?: boolean } = {}): Promise<TrmnlInstallation | undefined> {
        const installation = await this.dbRepo.findBySiteId(siteId);

        if (installation && !options.includeTokens) {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const { access_token: _at, refresh_token: _rt, ...safe } = installation;
            return safe as TrmnlInstallation;
        }

        return installation;
    }

    async deleteInstallation(uuid: string) {
        await this.dbRepo.delete(uuid);
    }

    async exchangeCodeForToken(code: string, clientId: string, clientSecret: string): Promise<{ access_token: string, user_uuid?: string, uuid?: string, user?: { uuid?: string } }> {
        const response = await fetch('https://trmnl.com/oauth/token', {
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
        return this.dbRepo.findPendingByPluginId(pluginSettingId);
    }

    async getLatestLoosePendingInstallation(): Promise<TrmnlInstallation | undefined> {
        return this.dbRepo.findLatestLoosePending();
    }

    async claimPendingInstallationById(id: number, uuid: string, pluginSettingId: number, json: unknown) {
        await this.dbRepo.claimPendingById(id, uuid, pluginSettingId, json);
    }

    async claimPendingInstallation(pluginSettingId: number, uuid: string, json: unknown) {
        await this.dbRepo.claimPending(pluginSettingId, uuid, json);
    }

    async fetchMe(accessToken: string): Promise<{ uuid: string }> {
        const response = await fetch('https://trmnl.com/api/me', {
            headers: { 'Authorization': `Bearer ${accessToken}` }
        });

        if (!response.ok) {
            const body = await response.text();
            throw new Error(`Failed to fetch user info from Trmnl: ${response.status} ${body}`);
        }

        return await response.json();
    }
}
