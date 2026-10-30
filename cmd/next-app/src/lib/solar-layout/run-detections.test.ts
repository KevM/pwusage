import { describe, expect, it, vi } from 'vitest';
import { runDueDetections, type DetectionRepo } from './run-detections';

function fakeRepo(siteIds: string[]) {
    const repo = {
        listDue: vi.fn(async () => siteIds.map(siteId => ({ siteId, timezone: 'America/Chicago', latitude: 43.39, longitude: -87.87 }))),
        saveResult: vi.fn(async () => {}),
        recordFailure: vi.fn(async () => {}),
    };
    return repo satisfies DetectionRepo;
}

const now = new Date('2026-10-27T12:00:00Z');

describe('runDueDetections', () => {
    it('saves a result for each due site', async () => {
        const repo = fakeRepo(['s1', 's2']);
        const loadSamples = vi.fn(async () => []);
        const out = await runDueDetections({ now, budgetMs: 35_000, repo, loadSamples });
        expect(repo.listDue).toHaveBeenCalledWith(5, now);
        expect(repo.saveResult).toHaveBeenCalledTimes(2);
        expect(repo.saveResult).toHaveBeenCalledWith('s1', expect.objectContaining({ status: 'not-enough-history' }), 1, { latitude: 43.39, longitude: -87.87 });
        expect(out.sites.map(s => [s.siteId, s.status])).toEqual([['s1', 'not-enough-history'], ['s2', 'not-enough-history']]);
        expect(out.stopped).toBe(false);
        const [, tz, start, end] = loadSamples.mock.calls[0] as unknown as [string, string, Date, Date];
        expect(tz).toBe('America/Chicago');
        expect(end.getTime() - start.getTime()).toBe(365 * 86_400_000);
    });

    it('saves a detected result on a subsequent due attempt', async () => {
        const repo = fakeRepo(['s1']);
        const detect = vi.fn().mockReturnValueOnce({ status: 'not-enough-history', confidence: null, reasons: [], planes: [], acClipKw: null, historyDays: 41, clearDays: 0, firstDay: null, lastDay: null, shading: [] }).mockReturnValueOnce({ status: 'detected', confidence: 'high', reasons: [], planes: [], acClipKw: null, historyDays: 42, clearDays: 20, firstDay: null, lastDay: null, shading: [] });
        await runDueDetections({ now, budgetMs: 35_000, repo, loadSamples: async () => [], detect });
        await runDueDetections({ now: new Date(now.getTime() + 86_400_000), budgetMs: 35_000, repo, loadSamples: async () => [], detect });
        expect(repo.saveResult).toHaveBeenLastCalledWith('s1', expect.objectContaining({ status: 'detected' }), 1, { latitude: 43.39, longitude: -87.87 });
    });

    it('records a failure and moves on when one site throws', async () => {
        const repo = fakeRepo(['s1', 's2']);
        const loadSamples = vi.fn(async (siteId: string) => {
            if (siteId === 's1') throw new Error('boom');
            return [];
        });
        const out = await runDueDetections({ now, budgetMs: 35_000, repo, loadSamples });
        expect(repo.recordFailure).toHaveBeenCalledWith('s1', { latitude: 43.39, longitude: -87.87 });
        expect(repo.saveResult).toHaveBeenCalledTimes(1);
        expect(repo.saveResult).toHaveBeenCalledWith('s2', expect.anything(), 1, { latitude: 43.39, longitude: -87.87 });
        expect(out.sites.map(s => s.status)).toEqual(['failed', 'not-enough-history']);
    });

    it('records a failure when detection runs past its deadline', async () => {
        const repo = fakeRepo(['s1']);
        const detect = vi.fn(() => { throw new Error('deadline'); });
        const out = await runDueDetections({ now, budgetMs: 35_000, repo, loadSamples: async () => [], detect });
        expect(repo.recordFailure).toHaveBeenCalledWith('s1', { latitude: 43.39, longitude: -87.87 });
        expect(repo.saveResult).not.toHaveBeenCalled();
        expect(out.sites[0].status).toBe('failed');
    });

    it('clamps each site deadline to the earlier of per-site limit and overall deadline', async () => {
        const repo = fakeRepo(['s1', 's2']);
        let mockTime = 100_000;
        const clock = () => mockTime;
        const detect = vi.fn((_opts: { deadline?: number }) => {
            mockTime += 10_000;
            return {
                status: 'detected' as const, confidence: 'high' as const, reasons: [], planes: [],
                acClipKw: null, historyDays: 50, clearDays: 20, firstDay: null, lastDay: null, shading: [],
            };
        });
        // overall deadline is startedAt (100_000) + deadlineMs (25_000) = 125_000
        // perSiteDeadlineMs is 15_000
        // s1 starts at 100_000: min(125_000, 100_000 + 15_000) = 115_000
        // s1 takes 10_000 ms, so s2 starts at 110_000: min(125_000, 110_000 + 15_000 = 125_000) = 125_000
        await runDueDetections({
            now, budgetMs: 20_000, repo, loadSamples: async () => [],
            clock, detect, deadlineMs: 25_000, perSiteDeadlineMs: 15_000,
        });
        expect(detect).toHaveBeenCalledTimes(2);
        expect(detect.mock.calls[0]?.[0]?.deadline).toBe(115_000);
        expect(detect.mock.calls[1]?.[0]?.deadline).toBe(125_000);
    });

    it('records failure even when caller ioSignal is already aborted', async () => {
        const { withIoDeadline, ioSignal } = await import('@/lib/io-deadline');
        const repo = fakeRepo(['s1']);
        let recordedInAbortedContext = true;
        repo.recordFailure = vi.fn(async () => {
            recordedInAbortedContext = ioSignal()?.aborted ?? false;
        });

        const controller = new AbortController();
        const detect = vi.fn(() => {
            controller.abort();
            throw new Error('timeout');
        });

        await withIoDeadline(10_000, async () => {
            await runDueDetections({ now, budgetMs: 35_000, repo, loadSamples: async () => [], detect });
        }, controller.signal).catch(() => undefined);

        expect(repo.recordFailure).toHaveBeenCalledWith('s1', { latitude: 43.39, longitude: -87.87 });
        expect(recordedInAbortedContext).toBe(false);
    });

    it('starts no sites without budget', async () => {
        const repo = fakeRepo(['s1']);
        const loadSamples = vi.fn(async () => []);
        const out = await runDueDetections({ now, budgetMs: 0, repo, loadSamples });
        expect(loadSamples).not.toHaveBeenCalled();
        expect(out).toEqual({ sites: [], stopped: true });
    });
});
