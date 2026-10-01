import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const run = vi.hoisted(() => vi.fn());
vi.mock('@/lib/history-retention-service', () => ({ HistoryRetentionService: class { run = run; } }));
import { GET } from './route';
describe('retention cleanup cron', () => {
    beforeEach(() => { vi.stubEnv('CRON_SECRET', 'secret'); vi.stubEnv('RETENTION_CLEANUP_ENABLED', ''); run.mockReset(); });
    afterEach(() => vi.unstubAllEnvs());
    it('requires cron authentication', async () => {
        const res = await GET(new NextRequest('http://localhost/api/cron/cleanup'));
        expect(res.status).toBe(401); expect(run).not.toHaveBeenCalled();
    });
    it('is disabled by default before any database cleanup', async () => {
        const res = await GET(new NextRequest('http://localhost/api/cron/cleanup', { headers: { authorization: 'Bearer secret' } }));
        expect(await res.json()).toMatchObject({ success: true, enabled: false }); expect(run).not.toHaveBeenCalled();
    });
    it('delegates account policy cleanup only after explicit activation', async () => {
        vi.stubEnv('RETENTION_CLEANUP_ENABLED', 'true'); vi.stubEnv('DATA_RETENTION_DAYS', '1');
        run.mockResolvedValue({ enabled: true, deleted: { energy: 3, tags: 1 }, skippedSites: [], batches: 1, workRemaining: false });
        const res = await GET(new NextRequest('http://localhost/api/cron/cleanup', { headers: { authorization: 'Bearer secret' } }));
        expect(await res.json()).toMatchObject({ success: true, enabled: true, deleted: { energy: 3, tags: 1 } });
        expect(run).toHaveBeenCalledExactlyOnceWith({ apply: true });
    });
});
