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

    it('findPendingByPluginId queries correct criteria', async () => {
        queryMock.mockResolvedValueOnce({ rows: [] });
        const repo = new TrmnlInstallationRepo();
        await repo.findPendingByPluginId(999);
        expect(queryMock).toHaveBeenCalledWith(
            expect.stringContaining('plugin_setting_id = $1 AND uuid IS NULL'),
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
            ['site-1', 'uuid-1', 456, { name: 'test' }, 'token-abc']
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

    it('updateJson updates settings config', async () => {
        queryMock.mockResolvedValueOnce({ rows: [] });
        const repo = new TrmnlInstallationRepo();
        await repo.updateJson(42, { cfg: true });
        expect(queryMock).toHaveBeenCalledWith(
            expect.stringContaining('UPDATE "TrmnlInstallation" SET json = $1 WHERE id = $2'),
            [{ cfg: true }, 42]
        );
    });

    it('claimPendingById links pending device', async () => {
        queryMock.mockResolvedValueOnce({ rows: [] });
        const repo = new TrmnlInstallationRepo();
        await repo.claimPendingById(5, 'uuid-abc', 99, { data: 1 });
        expect(queryMock).toHaveBeenCalledWith(
            expect.stringMatching(/UPDATE "TrmnlInstallation"\s+SET uuid = \$1, plugin_setting_id = \$2, json = \$3\s+WHERE id = \$4/),
            ['uuid-abc', 99, { data: 1 }, 5]
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
