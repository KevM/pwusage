import { describe, expect, it, vi } from 'vitest';
import { HistoryRetentionService } from './history-retention-service';
import type { RetentionSite } from './history-retention-repo';

const now = new Date('2026-10-01T18:00:00Z');
const site: RetentionSite = { siteId: 's1', userId: 'u1', timezone: 'UTC', policy: { history_retention_days: 90, history_retention_grace_until: null, history_retention_transition_pending: false } };
const dummyDb = { query: vi.fn() };
function setup(sites: RetentionSite[] = [site]) {
    const repo = {
        listSites: vi.fn().mockResolvedValue(sites),
        preview: vi.fn().mockResolvedValue([{ siteId: 's1', energy: 4, tags: 2 }]),
        withLockedSite: vi.fn(async <T>(_id: string, callback: (locked: RetentionSite, db: typeof dummyDb) => Promise<T>): Promise<T> => callback(sites.find(site => site.siteId === _id) ?? sites[0], dummyDb)),
    };
    const energy = { deleteExpiredBatch: vi.fn().mockResolvedValue(2) };
    const tags = { deleteExpiredBatch: vi.fn().mockResolvedValue(1) };
    return { repo, energy, tags, service: new HistoryRetentionService({ repo, energy, tags }) };
}

describe('retention cleanup service', () => {
    it('previews by default without locks or deletion', async () => {
        const { service, repo, energy } = setup();
        const result = await service.run({ now });
        expect(result.sites[0]).toMatchObject({ cutoff: '2026-07-03T00:00:00.000Z', eligibleEnergy: 4, eligibleTags: 2 });
        expect(result.deleted).toEqual({ energy: 0, tags: 0 });
        expect(repo.withLockedSite).not.toHaveBeenCalled(); expect(energy.deleteExpiredBatch).not.toHaveBeenCalled();
    });
    it('refuses activation while any existing account awaits notice bootstrap', async () => {
        const { service, energy } = setup([{ ...site, policy: { ...site.policy!, history_retention_transition_pending: true } }]);
        const result = await service.run({ apply: true, now });
        expect(result.enabled).toBe(false); expect(result.disabledReason).toContain('transition');
        expect(energy.deleteExpiredBatch).not.toHaveBeenCalled();
    });
    it('validates all account policies before any deletion', async () => {
        const { service, energy } = setup([site, { ...site, siteId: 's2', policy: { ...site.policy!, history_retention_days: 180 } as never }]);
        await expect(service.run({ apply: true, now })).rejects.toThrow();
        expect(energy.deleteExpiredBatch).not.toHaveBeenCalled();
    });
    it('skips and reports unowned sites', async () => {
        const { service, repo } = setup([{ siteId: 'orphan', userId: null, timezone: 'UTC', policy: null }]);
        const result = await service.run({ apply: true, now });
        expect(result.skippedSites).toEqual(['orphan']); expect(result.sites).toEqual([]);
        expect(repo.withLockedSite).not.toHaveBeenCalled();
    });
    it('uses bounded batches and reports remaining work', async () => {
        const { service, repo, energy, tags } = setup();
        const result = await service.run({ apply: true, now, batchSize: 2, maxBatches: 1 });
        expect(energy.deleteExpiredBatch).toHaveBeenCalledWith('s1', new Date('2026-07-03T00:00:00Z'), 2, dummyDb);
        expect(tags.deleteExpiredBatch).toHaveBeenCalledWith('s1', new Date('2026-07-03T00:00:00Z'), 2, dummyDb);
        expect(repo.withLockedSite).toHaveBeenCalledTimes(1); expect(result.batches).toBe(1); expect(result.workRemaining).toBe(true);
        expect(result.deleted).toEqual({ energy: 2, tags: 1 });
    });
    it('rechecks entitlements under a lock before deletion to preserve a concurrent grant', async () => {
        const { service, repo, energy } = setup();
        repo.withLockedSite.mockImplementation(async (_id, callback) => callback({ ...site, policy: { ...site.policy!, history_retention_days: 365 } }, dummyDb));
        await service.run({ apply: true, now, maxBatches: 1 });
        expect(energy.deleteExpiredBatch.mock.calls[0][1].toISOString()).toBe('2025-10-01T00:00:00.000Z');
    });
    it('uses remaining budget to continue a large backlog in bounded batches', async () => {
        const { service, repo, energy, tags } = setup();
        repo.preview.mockResolvedValue([{ siteId: 's1', energy: 2500, tags: 0 }]);
        energy.deleteExpiredBatch.mockResolvedValue(1000); tags.deleteExpiredBatch.mockResolvedValue(0);
        const report = await service.run({ apply: true, now, maxBatches: 2 });
        expect(repo.withLockedSite).toHaveBeenCalledTimes(2);
        expect(report.deleted.energy).toBe(2000);
        expect(report.workRemaining).toBe(true);
    });
    it('prioritizes growing backlogs so a fixed batch budget cannot starve later sites', async () => {
        const { service, repo } = setup([site, { ...site, siteId: 's2' }]);
        repo.preview.mockResolvedValue([{ siteId: 's1', energy: 1, tags: 0 }, { siteId: 's2', energy: 1000, tags: 0 }]);
        await service.run({ apply: true, now, maxBatches: 1 });
        expect(repo.withLockedSite.mock.calls[0][0]).toBe('s2');
    });
    it('rejects invalid batch budgets before reading or deleting', async () => {
        const { service, repo } = setup();
        await expect(service.run({ apply: true, now, batchSize: 0 })).rejects.toThrow();
        expect(repo.listSites).not.toHaveBeenCalled();
    });
});
