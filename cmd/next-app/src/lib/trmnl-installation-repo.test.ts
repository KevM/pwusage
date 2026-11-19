import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMock } = vi.hoisted(() => ({
    queryMock: vi.fn()
}));

vi.mock('./db', () => ({
    pool: {
        query: queryMock
    }
}));

import { TrmnlInstallationRepo } from './trmnl-installation-repo';

describe('TrmnlInstallationRepo', () => {
    beforeEach(() => {
        queryMock.mockReset();
    });

    it('findByUuid queries correct table', async () => {
        queryMock.mockResolvedValueOnce({ rows: [{ id: 1, uuid: 'uuid-123' }] });
        const repo = new TrmnlInstallationRepo();
        const result = await repo.findByUuid('uuid-123');
        expect(result?.uuid).toBe('uuid-123');
        expect(queryMock).toHaveBeenCalledWith(
            expect.stringContaining('SELECT * FROM "TrmnlInstallation" WHERE uuid = $1'),
            ['uuid-123']
        );
    });

    it('findBySiteId queries with ordering and limit', async () => {
        queryMock.mockResolvedValueOnce({ rows: [{ id: 2 }] });
        const repo = new TrmnlInstallationRepo();
        await repo.findBySiteId('site-abc');
        expect(queryMock).toHaveBeenCalledWith(
            expect.stringMatching(/SELECT \* FROM "TrmnlInstallation"\s+WHERE site_id = \$1/),
            ['site-abc']
        );
    });

    it('findAllBySiteId returns every install for the site, best first, without a limit', async () => {
        queryMock.mockResolvedValueOnce({ rows: [{ id: 2 }, { id: 1 }] });
        const repo = new TrmnlInstallationRepo();
        const result = await repo.findAllBySiteId('site-abc');
        expect(result).toEqual([{ id: 2 }, { id: 1 }]);
        const [sql, params] = queryMock.mock.calls[0];
        expect(sql).toMatch(/WHERE site_id = \$1/);
        expect(sql).toMatch(/ORDER BY \(plugin_setting_id IS NOT NULL\) DESC, created_at DESC, id DESC/);
        expect(sql).not.toMatch(/LIMIT/);
        expect(params).toEqual(['site-abc']);
    });

    it('findPendingByPluginId queries correct criteria and enforces verified flag when requested', async () => {
        queryMock.mockResolvedValueOnce({ rows: [] });
        const repo = new TrmnlInstallationRepo();
        await repo.findPendingByPluginId(999);
        expect(queryMock).toHaveBeenCalledWith(
            expect.stringContaining('plugin_setting_id = $1 AND uuid IS NULL'),
            [999]
        );

        queryMock.mockResolvedValueOnce({ rows: [] });
        await repo.findPendingByPluginId(999, { requireVerified: true });
        expect(queryMock).toHaveBeenLastCalledWith(
            expect.stringContaining('plugin_setting_id = $1 AND uuid IS NULL AND plugin_setting_id_verified = true'),
            [999]
        );
    });

    it('findLatestLoosePending queries correctly', async () => {
        queryMock.mockResolvedValueOnce({ rows: [] });
        const repo = new TrmnlInstallationRepo();
        await repo.findLatestLoosePending();
        expect(queryMock).toHaveBeenCalledWith(
            expect.stringContaining('uuid IS NULL AND plugin_setting_id IS NULL')
        );
    });

    it('create inserts correct parameters', async () => {
        queryMock.mockResolvedValueOnce({ rows: [{ id: 10 }] });
        const repo = new TrmnlInstallationRepo();
        const id = await repo.create('site-1', 'uuid-1', 456, { name: 'test' }, 'token-abc');
        expect(id).toBe(10);
        expect(queryMock).toHaveBeenCalledWith(
            expect.stringContaining('INSERT INTO "TrmnlInstallation"'),
            ['site-1', 'uuid-1', 456, { name: 'test' }, 'token-abc', null]
        );
    });

    it('upsertSettings saves settings payload', async () => {
        queryMock.mockResolvedValueOnce({ rows: [{ id: 12 }] });
        const repo = new TrmnlInstallationRepo();
        await repo.upsertSettings('uuid-1', 'site-1', { a: 1 }, 777);
        expect(queryMock).toHaveBeenCalledWith(
            expect.stringContaining('INSERT INTO "TrmnlInstallation" (uuid, site_id, json, plugin_setting_id)'),
            ['uuid-1', 'site-1', { a: 1 }, 777]
        );
    });

    it('updatePluginId updates plugin mapping', async () => {
        queryMock.mockResolvedValueOnce({ rows: [] });
        const repo = new TrmnlInstallationRepo();
        await repo.updatePluginId('uuid-1', 123);
        expect(queryMock).toHaveBeenCalledWith(
            expect.stringContaining('UPDATE "TrmnlInstallation" SET plugin_setting_id = $1 WHERE uuid = $2'),
            [123, 'uuid-1']
        );
    });

    it('updateWebhookMetadata updates only metadata when id, uuid, and site_id still match', async () => {
        queryMock.mockResolvedValueOnce({ rows: [{ id: 1 }] });
        const repo = new TrmnlInstallationRepo();
        const ok = await repo.updateWebhookMetadata(1, 'uuid-1', 'site-1', 55, { screens: [] });
        expect(ok).toBe(true);
        expect(queryMock).toHaveBeenCalledWith(
            expect.stringMatching(/UPDATE "TrmnlInstallation"\s+SET plugin_setting_id = COALESCE\(\$4, plugin_setting_id\),\s+json = \$5\s+WHERE id = \$1\s+AND uuid = \$2\s+AND site_id = \$3\s+RETURNING id/),
            [1, 'uuid-1', 'site-1', 55, { screens: [] }]
        );

        queryMock.mockResolvedValueOnce({ rows: [] });
        const stale = await repo.updateWebhookMetadata(1, 'uuid-1', 'site-1', 55, { screens: [] });
        expect(stale).toBe(false);
    });

    it('updateJson updates settings config', async () => {
        queryMock.mockResolvedValueOnce({ rows: [] });
        const repo = new TrmnlInstallationRepo();
        await repo.updateJson(42, { cfg: true });
        expect(queryMock).toHaveBeenCalledWith(
            expect.stringContaining('UPDATE "TrmnlInstallation" SET json = $1 WHERE id = $2'),
            [{ cfg: true }, 42]
        );
    });

    it('updateCarouselIndex updates only the carousel_index key inside json column', async () => {
        queryMock.mockResolvedValueOnce({ rows: [] });
        const repo = new TrmnlInstallationRepo();
        await repo.updateCarouselIndex(42, 2);
        expect(queryMock).toHaveBeenCalledWith(
            expect.stringContaining('UPDATE "TrmnlInstallation" SET json = jsonb_set(COALESCE(json, \'{}\'::jsonb), \'{carousel_index}\', to_jsonb($1::int), true) WHERE id = $2'),
            [2, 42]
        );
    });

    it('claimPendingById links pending device atomically when uuid is null', async () => {
        queryMock.mockResolvedValueOnce({ rows: [{ id: 5 }] });
        const repo = new TrmnlInstallationRepo();
        const claimed = await repo.claimPendingById(5, 'uuid-abc', 99, { data: 1 });
        expect(claimed).toBe(true);
        expect(queryMock).toHaveBeenCalledWith(
            expect.stringMatching(/UPDATE "TrmnlInstallation"\s+SET uuid = \$1, plugin_setting_id = \$2, json = \$3\s+WHERE id = \$4\s+AND uuid IS NULL\s+AND \(plugin_setting_id IS NULL OR plugin_setting_id = \$2\)\s+RETURNING id/),
            ['uuid-abc', 99, { data: 1 }, 5]
        );
    });

    it('claimPendingById returns false when already claimed or plugin_setting_id conflicts', async () => {
        queryMock.mockResolvedValueOnce({ rows: [] });
        const repo = new TrmnlInstallationRepo();
        const claimed = await repo.claimPendingById(5, 'uuid-other', 99, { data: 1 });
        expect(claimed).toBe(false);
    });

    it('create with allowedExistingSiteIds enforces site_id ownership in ON CONFLICT WHERE and returns null when rejected', async () => {
        queryMock.mockResolvedValueOnce({ rows: [] });
        const repo = new TrmnlInstallationRepo();
        const id = await repo.create('site-a', 'uuid-b', 10, {}, 'tok-a', 'user-a', {
            allowedExistingSiteIds: ['site-a']
        });
        expect(id).toBeNull();
        expect(queryMock).toHaveBeenCalledWith(
            expect.stringContaining('WHERE "TrmnlInstallation".site_id = ANY($7::text[])'),
            ['site-a', 'uuid-b', 10, {}, 'tok-a', 'user-a', ['site-a']]
        );
    });

    it('claimPending updates pending by plugin id', async () => {
        queryMock.mockResolvedValueOnce({ rows: [] });
        const repo = new TrmnlInstallationRepo();
        await repo.claimPending(88, 'uuid-x', { val: 2 });
        expect(queryMock).toHaveBeenCalledWith(
            expect.stringMatching(/UPDATE "TrmnlInstallation"\s+SET uuid = \$1, json = \$2\s+WHERE plugin_setting_id = \$3 AND uuid IS NULL/),
            ['uuid-x', { val: 2 }, 88]
        );
    });

    it('delete removes installation', async () => {
        queryMock.mockResolvedValueOnce({ rows: [] });
        const repo = new TrmnlInstallationRepo();
        await repo.delete('uuid-99');
        expect(queryMock).toHaveBeenCalledWith(
            expect.stringContaining('DELETE FROM "TrmnlInstallation" WHERE uuid = $1'),
            ['uuid-99']
        );
    });
});

describe('TrmnlInstallationRepo.findByUuidWithSite', () => {
    beforeEach(() => {
        queryMock.mockReset();
    });

    it('returns installation + site when both exist', async () => {
        // First query: findByUuid
        queryMock.mockResolvedValueOnce({
            rows: [{ id: 1, uuid: 'u-1', site_id: 'site-1', plugin_setting_id: null, created_at: new Date(), json: {}, access_token: null, refresh_token: null }]
        });
        // Second/third queries: SiteRepo.getSite -> loadSitesFromDB
        // (site scalars query, then the tariff tree query)
        queryMock.mockResolvedValueOnce({
            rows: [{
                id: 'site-1', user_id: 'u', name: 'Home', utility: null,
                updated: new Date(), installed: new Date(), timezone: 'America/Chicago',
                billing_start_day: 1, timezone_display_mode: null,
                access_token: 'a', refresh_token: 'r', auth_status: 'active',
            }]
        });
        queryMock.mockResolvedValueOnce({ rows: [] });

        const repo = new TrmnlInstallationRepo();
        const result = await repo.findByUuidWithSite('u-1', { includeTokens: true });
        expect(result?.installation.uuid).toBe('u-1');
        expect(result?.site.id).toBe('site-1');
        expect(result?.site.access_token).toBe('a');
    });

    it('returns undefined when installation not found', async () => {
        queryMock.mockResolvedValueOnce({ rows: [] });
        const repo = new TrmnlInstallationRepo();
        const result = await repo.findByUuidWithSite('missing');
        expect(result).toBeUndefined();
    });

    it('returns undefined when site disappears', async () => {
        queryMock
            .mockResolvedValueOnce({ rows: [{ id: 1, uuid: 'u-1', site_id: 'orphan' }] })
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [] });
        const repo = new TrmnlInstallationRepo();
        const result = await repo.findByUuidWithSite('u-1');
        expect(result).toBeUndefined();
    });
});
