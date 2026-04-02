import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMock } = vi.hoisted(() => ({
    queryMock: vi.fn()
}));

vi.mock('./db', () => ({
    pool: {
        query: queryMock
    }
}));

import { EnergyRepo } from './energy-repo';

describe('EnergyRepo site payload selection', () => {
    beforeEach(() => {
        queryMock.mockReset();
        const repo = new EnergyRepo();
        repo.invalidateCache('site-1');
    });

    it('fetches slim site columns by default', async () => {
        queryMock
            .mockResolvedValueOnce({
                rows: [{
                    id: 'site-1',
                    user_id: 'user-1',
                    name: 'Home',
                    updated: new Date(),
                    installed: new Date(),
                    timezone: 'America/Chicago',
                    billing_start_day: 1
                }]
            })
            .mockResolvedValueOnce({ rows: [{ access_token: 'a', refresh_token: 'r', auth_status: 'active' }] })
            .mockResolvedValueOnce({ rows: [] });

        const repo = new EnergyRepo();
        await repo.getSite('site-1');

        expect(queryMock).toHaveBeenCalledWith(
            expect.stringContaining('SELECT id, user_id, name, utility, updated, installed, timezone, billing_start_day'),
            ['site-1']
        );
        expect(queryMock).not.toHaveBeenCalledWith(
            expect.stringContaining('SELECT * FROM "Site" WHERE id = $1'),
            expect.anything()
        );
    });

    it('includes site json only when explicitly requested', async () => {
        queryMock
            .mockResolvedValueOnce({
                rows: [{
                    id: 'site-1',
                    user_id: 'user-1',
                    name: 'Home',
                    updated: new Date(),
                    installed: new Date(),
                    timezone: 'America/Chicago',
                    json: { components: { battery: true } },
                    billing_start_day: 1
                }]
            })
            .mockResolvedValueOnce({ rows: [{ access_token: 'a', refresh_token: 'r', auth_status: 'active' }] })
            .mockResolvedValueOnce({ rows: [] });

        const repo = new EnergyRepo();
        const site = await repo.getSite('site-1', { includeJson: true });

        expect(queryMock).toHaveBeenCalledWith(
            expect.stringContaining('SELECT id, user_id, name, utility, updated, installed, timezone, billing_start_day, timezone_display_mode, json'),
            ['site-1']
        );
        expect(site?.json).toEqual({ components: { battery: true } });
    });

    it('fetches slim site rows for user lists', async () => {
        queryMock.mockResolvedValueOnce({
            rows: [{
                id: 'site-1',
                user_id: 'user-1',
                name: 'Home',
                updated: new Date(),
                installed: new Date(),
                timezone: 'America/Chicago',
                billing_start_day: 1
            }]
        });

        const repo = new EnergyRepo();
        await repo.getSitesForUser('user-1');

        expect(queryMock).toHaveBeenCalledWith(
            expect.stringContaining('SELECT id, user_id, name, utility, updated, installed, timezone, billing_start_day'),
            ['user-1']
        );
        expect(queryMock).not.toHaveBeenCalledWith(
            expect.stringContaining('SELECT * FROM "Site" WHERE user_id = $1'),
            expect.anything()
        );
    });

    it('does not fetch site json for TRMNL installation lookups', async () => {
        queryMock
            .mockResolvedValueOnce({
                rows: [{
                    id: 1,
                    uuid: 'uuid-1',
                    site_id: 'site-1',
                    plugin_setting_id: 123,
                    created_at: new Date(),
                    json: { device: true },
                    access_token: 'install-token',
                    refresh_token: 'install-refresh',
                    tesla_access_token: 'tesla-token',
                    tesla_refresh_token: 'tesla-refresh',
                    tesla_auth_status: 'active'
                }]
            })
            .mockResolvedValueOnce({
                rows: [{
                    id: 'site-1',
                    user_id: 'user-1',
                    name: 'Home',
                    updated: new Date(),
                    installed: new Date(),
                    timezone: 'America/Chicago',
                    billing_start_day: 1
                }]
            })
            .mockResolvedValueOnce({ rows: [{ access_token: 'tesla-token', refresh_token: 'tesla-refresh', auth_status: 'active' }] })
            .mockResolvedValueOnce({ rows: [] });

        const repo = new EnergyRepo();
        const result = await repo.getInstallationAndSite('uuid-1');

        expect(queryMock).toHaveBeenNthCalledWith(
            1,
            expect.not.stringContaining('s.json as site_json'),
            ['uuid-1']
        );
        expect(result?.site.json).toBeUndefined();
    });
});
